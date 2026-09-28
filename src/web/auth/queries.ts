import { eq, sql } from 'drizzle-orm';
import type { Db, Queryable } from '../../db/client';
import { isLockTimeout } from '../../db/errors';
import { file, pendingPhoto, user } from '../../db/schema';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { type StoredPhoto, unkeyedPhoto } from '../files/image-variant';
import { STORED_PHOTO_COLUMNS } from '../files/queries';
import { revokeDevices } from '../push/queries';
import { revokeAllTokens } from './personal-tokens';

/**
 * Account rows. Emails are stored as normalizeEmail writes them (trimmed,
 * lower case; drizzle/0005 converted the older rows) and are unique
 * case-insensitively: the `user_lower_email_unique` index on lower(email),
 * which is also what the lookups below use. The register and update-email
 * routes still check first, for a message under the field; a concurrent
 * write that wins the race is the index's unique violation.
 */

export interface AccountRow {
  id: number;
  email: string | null;
  password: string;
}

const accountColumns = {
  id: user.id,
  email: user.email,
  password: user.password,
};

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUserById(
  db: Db,
  id: number,
): Promise<AccountRow | undefined> {
  const [row] = await db
    .select(accountColumns)
    .from(user)
    .where(eq(user.id, id));
  return row;
}

/** `email` must already be normalized. */
export async function findUserByEmail(
  db: Db,
  email: string,
): Promise<AccountRow | undefined> {
  const [row] = await db
    .select(accountColumns)
    .from(user)
    .where(eq(sql`lower(${user.email})`, email))
    .limit(1);
  return row;
}

/**
 * `email` must already be normalized; the caller checked it is free.
 * Registration asks for no name; the seed's personas have one (the share
 * page says "Shared by" the first name).
 */
export async function insertUser(
  db: Queryable,
  email: string,
  passwordHash: string,
  name: { firstName?: string; lastName?: string } = {},
): Promise<AccountRow> {
  const [row] = await db
    .insert(user)
    .values({ email, password: passwordHash, ...name })
    .returning(accountColumns);
  return row;
}

/** What a new password took away, besides every other session. */
export interface PasswordChange {
  account: AccountRow;
  revokedTokens: number;
  revokedDevices: number;
}

/**
 * The one writer of a password. The new hash ends every session issued
 * before it (the fingerprint), and the same transaction revokes every
 * personal access token and every push subscription but `keepEndpoint`'s
 * (the device making the change, if it has one): a new password is how an
 * account is taken back, and a device signed out by it must stop receiving
 * the account's notifications at once (revokeDevices).
 */
export function updatePasswordHash(
  db: Db,
  id: number,
  passwordHash: string,
  keepEndpoint?: string,
): Promise<PasswordChange> {
  return db.transaction(async (tx) => {
    const [account] = await tx
      .update(user)
      .set({ password: passwordHash })
      .where(eq(user.id, id))
      .returning(accountColumns);
    const revokedTokens = await revokeAllTokens(tx, id);
    const revokedDevices = await revokeDevices(tx, id, keepEndpoint);
    return { account, revokedTokens, revokedDevices };
  });
}

export async function updateEmail(
  db: Db,
  id: number,
  email: string,
): Promise<void> {
  await db.update(user).set({ email }).where(eq(user.id, id));
}

/**
 * Deletes the user, their File rows and their pending photos' rows in
 * one transaction and returns the stored photos, which the caller unlinks
 * after commit: the database cascade
 * drops rows (garments, outfits, calendar entries, shares), never the photo
 * bytes (CLAUDE.md Gotchas).
 */
export async function deleteUserAndFileRows(
  db: Db,
  id: number,
): Promise<StoredPhoto[]> {
  return db.transaction(async (tx) => {
    const files = await tx
      .delete(file)
      .where(eq(file.createdById, id))
      .returning(STORED_PHOTO_COLUMNS);
    // Link imports never saved: their bytes have no `file` row, and the
    // cascade would drop the rows that explain them to reconciliation.
    const pending = await tx
      .delete(pendingPhoto)
      .where(eq(pendingPhoto.userId, id))
      .returning({ fileName: pendingPhoto.fileName });
    await tx.delete(user).where(eq(user.id, id));
    return [...files, ...pending.map((row) => unkeyedPhoto(row.fileName))];
  });
}

/**
 * Serializes one owner's writes that must see each other for the rest of
 * the transaction. The lock is on the owner's user row, because what is
 * being decided may have no row of its own to lock yet (a user's first
 * plan, the outfit a double tap would save twice, the entry a re-plan is
 * about to swap). NO KEY UPDATE leaves the row's key alone, so it never
 * blocks another table's foreign key check against the user (a garment
 * insert, a wear), only another such write of the same owner.
 *
 * The same statement bounds every lock wait from here to the end of the
 * transaction by OWNER_LOCK_TIMEOUT_MS (`set_config(..., true)` is SET
 * LOCAL with a bound value; in a savepoint it lasts to the caller's
 * commit), this one included: the select list is computed below the plan's
 * LockRows node, before the row is locked. One round trip, not two (#158;
 * production reaches Postgres over a ~114 ms link). owner-lock.spec.ts's
 * #134 case proves the bound holds (a re-plan behind a held lock defers).
 *
 * Writers call it through ownerTransaction; the rule it serves (every
 * writer of the calendar and the plan tables, the owner lock first) is in
 * src/web/calendar/CLAUDE.md, Owner lock.
 *
 * No row is a 404: the account is gone, typically deleted by deleteAccount
 * while this writer queued behind it. Going on unlocked would fail a
 * foreign key halfway, a 500.
 */
export async function lockOwner(tx: Queryable, ownerId: number): Promise<void> {
  const [locked] = await lockOwnerQuery(tx, ownerId);
  if (!locked) throw new HttpError(404, 'Wardrobe not found');
}

/**
 * lockOwner's statement, exported for owner-lock.spec.ts, which EXPLAINs it.
 *
 * Keep set_config in the base scan's select list. It bounds the lock wait
 * only because Postgres computes that list in the scan, below LockRows,
 * before the row lock is taken. Moved elsewhere (a CTE, a subquery, a
 * second statement's order), it may run after the wait or not at all. Any
 * change here is verified with EXPLAIN (VERBOSE): the scan's Output must
 * hold set_config. The spec asserts exactly that.
 */
export function lockOwnerQuery(tx: Queryable, ownerId: number) {
  return tx
    .select({
      id: user.id,
      lockTimeout: sql`set_config('lock_timeout', ${`${OWNER_LOCK_TIMEOUT_MS}ms`}, true)`,
    })
    .from(user)
    .where(eq(user.id, ownerId))
    .for('no key update');
}

/**
 * How long an owner transaction waits for any lock (the owner lock, or a
 * row lock under it) before it gives up: its `lock_timeout`. Behind a
 * stalled writer (a hung statement, a request stuck mid-transaction; the
 * pool's own timeouts end those, src/db/client.ts) a request fails fast
 * with OwnerLockTimeout instead of hanging with it.
 */
export const OWNER_LOCK_TIMEOUT_MS = 5_000;

/**
 * An owner transaction's lock wait ran past OWNER_LOCK_TIMEOUT_MS: a 503
 * asking to try again, logged with the owner and the writer. Nothing was
 * written (the transaction rolled back).
 */
export class OwnerLockTimeout extends HttpError {
  constructor(
    readonly ownerId: number,
    readonly writer: string,
  ) {
    super(503, t('WARDROBE_BUSY'), {
      logDetail: `${writer} for owner ${ownerId} waited ${OWNER_LOCK_TIMEOUT_MS} ms for a lock`,
    });
    this.name = 'OwnerLockTimeout';
  }
}

/**
 * The transactions whose work holds an owner's lock, and whose: a nested
 * ownerTransaction handed one of them joins it (see ownerTransaction).
 * Keyed by Drizzle's transaction object, so a savepoint the work opens on
 * its own (`tx.transaction`) is a new key and takes the lock again.
 */
const lockedFor = new WeakMap<Queryable, number>();

/**
 * `work` in a transaction (a savepoint inside a caller's) that holds the
 * owner lock from its first statement: the one way to write
 * outfit_calendar, the week planner's tables, wardrobe plans and their
 * items (src/web/calendar/CLAUDE.md, Owner lock). The lock comes before
 * any row lock `work` takes (an outfit, a garment, an entry): the re-plan
 * takes those under it too, so taking one first could deadlock. A trip's
 * lock is the one taken before it (src/web/trips). `writer` names the
 * operation for the log (the function's name).
 *
 * Every lock wait from here to the end of the transaction is bounded by
 * OWNER_LOCK_TIMEOUT_MS (lockOwner); a wait past it throws OwnerLockTimeout.
 *
 * **Nested in an ownerTransaction of the same owner** (handed its `tx`:
 * "Wear this" is pickIdea, then wearOutfitOn's insertEntry and
 * setEntryWorn, all in wearIdea's), `work` runs in the caller's
 * transaction as it is: no savepoint, no second lock. Each nesting used to
 * cost four statements (savepoint, lock timeout, lock, release; #158), one
 * round trip each. So a nested writer's failure is its caller's: a caller
 * that must carry on after one catches it inside its own
 * `tx.transaction(...)` savepoint (none does today).
 *
 * Nested inside any other transaction, this is a savepoint and the lock
 * belongs to the outermost transaction once taken. But if this savepoint
 * is the first to take it and then rolls back (`work` throws) while the
 * caller catches and carries on, the lock goes with the savepoint: the rest
 * of the caller's transaction runs unlocked. No caller does that today; one
 * that must keep going after a failed owner write takes lockOwner itself
 * first.
 */
export async function ownerTransaction<T>(
  db: Queryable,
  ownerId: number,
  writer: string,
  work: (tx: Queryable) => Promise<T>,
): Promise<T> {
  try {
    // Joined, the wait is still this writer's: mapped here, so the 503's
    // log names it (pickIdea's garments inside wearIdea), not the caller.
    if (lockedFor.get(db) === ownerId) return await work(db);
    return await db.transaction(async (tx) => {
      await lockOwner(tx, ownerId);
      lockedFor.set(tx, ownerId);
      try {
        return await work(tx);
      } finally {
        lockedFor.delete(tx);
      }
    });
  } catch (error) {
    // The innermost ownerTransaction maps it; the callers pass it on.
    if (!(error instanceof OwnerLockTimeout) && isLockTimeout(error)) {
      throw new OwnerLockTimeout(ownerId, writer);
    }
    throw error;
  }
}
