import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db, Queryable } from '../../../db/client';
import { orderEmail, orderItem, user } from '../../../db/schema';
import { selectScalars } from '../../../db/select-scalars';
import type { IsoDate } from '../../../calendar-date';
import {
  type OrderEmailOutcome,
  type OrderItemEvent,
  orderItemTransition,
} from '../../../wardrobe/order-items';

/**
 * The order mail's rows (#25; src/db/schema.ts, order_email and
 * order_item). One writer each: recordOrderEmail (the poll), and an item's
 * one move out of pending through decideOrderItem (the review list's
 * dismissal, and the garment save's `added` inside its own transaction).
 * Every read of an item names its owner, so another user's id is a 404.
 */

/** What a poll starts from (pollStart). */
export interface PollStart {
  /** ORDER_MAIL_OWNER's account; undefined when no account has the address. */
  ownerId: number | undefined;
  /** The newest processed email's arrival in the account: the next query's `after`. */
  watermark: Date | undefined;
}

/**
 * The owner's account and the account's watermark, in one statement (#173:
 * a poll was a statement for each). `ownerEmail` must already be
 * normalized (lower case), as findUserByEmail's is; only the id is read,
 * never the password hash that lookup carries.
 */
export async function pollStart(
  db: Db,
  ownerEmail: string,
  accountId: string,
): Promise<PollStart> {
  const { ownerId, newest } = await selectScalars(db, {
    ownerId: sql<number | null>`(
      select ${user.id} from ${user}
      where lower(${user.email}) = ${ownerEmail} limit 1
    )`,
    // As JSON: an ISO string, which Date reads (the raw row's timestamptz
    // text is not ISO).
    newest: sql<string | null>`(
      select to_json(max(${orderEmail.receivedAt})) from ${orderEmail}
      where ${orderEmail.accountId} = ${accountId}
    )`,
  });
  return {
    ownerId: ownerId ?? undefined,
    watermark: newest === null ? undefined : new Date(newest),
  };
}

/** Which of `emailIds` the account's emails were processed already. */
export async function processedEmailIds(
  db: Db,
  accountId: string,
  emailIds: readonly string[],
): Promise<Set<string>> {
  if (emailIds.length === 0) return new Set();
  const rows = await db
    .select({ emailId: orderEmail.emailId })
    .from(orderEmail)
    .where(
      and(
        eq(orderEmail.accountId, accountId),
        inArray(orderEmail.emailId, [...emailIds]),
      ),
    );
  return new Set(rows.map((row) => row.emailId));
}

/** A product the poll found, as the review list stores it. */
export interface FoundProduct {
  productUrl: string;
  name: string | null;
  brand: string | null;
  price: string | null;
  currency: string | null;
}

export interface ProcessedEmail {
  accountId: string;
  emailId: string;
  receivedAt: Date;
  outcome: OrderEmailOutcome;
}

/**
 * Records one email as processed with the products it listed for
 * `ownerId`, atomically. A product the owner has listed before (pending,
 * added or dismissed) is skipped, so a confirmation and a shipping email
 * name it once; `imported` becomes `no-products` when every product was
 * such a repeat. How many were listed; 0 too when another run recorded the
 * email first (an overlapping deploy).
 *
 * An email without products (untrusted, too large, none found) is one
 * insert. With products, one transaction of four statements (#173; it was
 * five): the email and its items in one statement (the items' insert reads
 * the email's new id from a CTE, and inserts nothing when the email was
 * recorded already), then the email's count and outcome, which only the
 * items' insert can tell.
 */
export async function recordOrderEmail(
  db: Db,
  email: ProcessedEmail,
  ownerId: number,
  orderedOn: IsoDate,
  products: readonly FoundProduct[],
): Promise<number> {
  const insertEmail = (tx: Queryable, outcome: OrderEmailOutcome) =>
    tx
      .insert(orderEmail)
      .values({ ...email, outcome, items: 0 })
      .onConflictDoNothing()
      .returning({ id: orderEmail.id });
  if (products.length === 0) {
    // Nothing listed: an `imported` email with no products is `no-products`.
    await insertEmail(
      db,
      email.outcome === 'imported' ? 'no-products' : email.outcome,
    );
    return 0;
  }
  return db.transaction(async (tx) => {
    const found = products.map(
      (product) =>
        sql`(${product.productUrl}::text, ${product.name}::text, ${product.brand}::text, ${product.price}::numeric, ${product.currency}::varchar)`,
    );
    const { rows } = await tx.execute<{
      emailId: number | null;
      listed: number;
    }>(sql`
      with email as (${insertEmail(tx, email.outcome).getSQL()}),
      listed as (
        insert into ${orderItem}
          (owner_id, order_email_id, product_url, name, brand, price, currency, ordered_on)
        select ${ownerId}::int, email.id, found.product_url, found.name,
          found.brand, found.price, found.currency, ${orderedOn}::date
        from email,
          (values ${sql.join(found, sql`, `)})
            as found(product_url, name, brand, price, currency)
        on conflict do nothing
        returning 1
      )
      select (select id from email) as "emailId",
        (select count(*)::int from listed) as listed`);
    const [{ emailId, listed }] = rows;
    if (emailId === null) return 0;
    if (email.outcome === 'imported') {
      await tx
        .update(orderEmail)
        .set({
          items: listed,
          outcome: listed > 0 ? 'imported' : 'no-products',
        })
        .where(eq(orderEmail.id, emailId));
    }
    return listed;
  });
}

export interface ReviewItem {
  id: number;
  productUrl: string;
  name: string | null;
  brand: string | null;
  price: string | null;
  currency: string | null;
  orderedOn: IsoDate;
}

const reviewColumns = {
  id: orderItem.id,
  productUrl: orderItem.productUrl,
  name: orderItem.name,
  brand: orderItem.brand,
  price: orderItem.price,
  currency: orderItem.currency,
  orderedOn: sql<IsoDate>`${orderItem.orderedOn}`,
};

/** The review list: `ownerId`'s pending items, the newest order first. */
export function pendingOrderItems(
  db: Db,
  ownerId: number,
): Promise<ReviewItem[]> {
  return db
    .select(reviewColumns)
    .from(orderItem)
    .where(and(eq(orderItem.ownerId, ownerId), eq(orderItem.state, 'pending')))
    .orderBy(desc(orderItem.orderedOn), desc(orderItem.id));
}

/** One of `ownerId`'s items while it is still pending. */
export async function findPendingOrderItem(
  db: Db,
  id: number,
  ownerId: number,
): Promise<ReviewItem | undefined> {
  const [row] = await db
    .select(reviewColumns)
    .from(orderItem)
    .where(
      and(
        eq(orderItem.id, id),
        eq(orderItem.ownerId, ownerId),
        eq(orderItem.state, 'pending'),
      ),
    );
  return row;
}

/**
 * Moves `ownerId`'s item `id` out of pending (orderItemTransition): `add`
 * with the garment saved from it (inside that garment's transaction),
 * `dismiss` on its own. False when it is not theirs or not pending any
 * more (dismissed meanwhile, or a second save of the same form): the one
 * guard against adding an order twice.
 */
export async function decideOrderItem(
  db: Queryable,
  id: number,
  ownerId: number,
  decision: { event: 'add'; garmentId: number } | { event: 'dismiss' },
): Promise<boolean> {
  const event: OrderItemEvent = decision.event;
  const state = orderItemTransition('pending', event);
  if (state === undefined) return false;
  const moved = await db
    .update(orderItem)
    .set({
      state,
      decidedAt: new Date(),
      ...(decision.event === 'add' && { garmentId: decision.garmentId }),
    })
    .where(
      and(
        eq(orderItem.id, id),
        eq(orderItem.ownerId, ownerId),
        eq(orderItem.state, 'pending'),
      ),
    )
    .returning({ id: orderItem.id });
  return moved.length > 0;
}
