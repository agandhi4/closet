import { and, desc, eq, inArray, max, sql } from 'drizzle-orm';
import type { Db, Queryable } from '../../../db/client';
import { orderEmail, orderItem } from '../../../db/schema';
import type { IsoDate } from '../../calendar/calendar-date';
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

/** The newest processed email's arrival in the account: the next query's `after`. */
export async function orderMailWatermark(
  db: Db,
  accountId: string,
): Promise<Date | undefined> {
  const [row] = await db
    .select({ newest: max(orderEmail.receivedAt) })
    .from(orderEmail)
    .where(eq(orderEmail.accountId, accountId));
  return row?.newest ?? undefined;
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
 * `ownerId`, in one transaction. A product the owner has listed before
 * (pending, added or dismissed) is skipped, so a confirmation and a
 * shipping email name it once; `imported` becomes `no-products` when every
 * product was such a repeat. How many were listed; 0 too when another run
 * recorded the email first (an overlapping deploy).
 */
export function recordOrderEmail(
  db: Db,
  email: ProcessedEmail,
  ownerId: number,
  orderedOn: IsoDate,
  products: readonly FoundProduct[],
): Promise<number> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(orderEmail)
      .values({ ...email, items: 0 })
      .onConflictDoNothing()
      .returning({ id: orderEmail.id });
    if (!row) return 0;
    const listed =
      products.length === 0
        ? []
        : await tx
            .insert(orderItem)
            .values(
              products.map((product) => ({
                ...product,
                ownerId,
                orderEmailId: row.id,
                orderedOn,
              })),
            )
            .onConflictDoNothing()
            .returning({ id: orderItem.id });
    if (email.outcome === 'imported') {
      await tx
        .update(orderEmail)
        .set({
          items: listed.length,
          outcome: listed.length > 0 ? 'imported' : 'no-products',
        })
        .where(eq(orderEmail.id, row.id));
    }
    return listed.length;
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
