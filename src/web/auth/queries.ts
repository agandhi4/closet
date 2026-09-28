import { eq, sql } from 'drizzle-orm';
import type { Db, Queryable } from '../../db/client';
import { isLockTimeout } from '../../db/errors';
import { file, pendingPhoto, user } from '../../db/schema';
import { HttpError } from '../errors';
import { t } from '../i18n';
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
 * one transaction and returns the stored names, which the caller unlinks
 * after commit: the database cascade
 * drops rows (garments, outfits, calendar entries, shares), never the photo
 * bytes (CLAUDE.md Gotchas).
 */
export async function deleteUserAndFileRows(
  db: Db,
  id: number,
): Promise<string[]> {
  return db.transaction(async (tx) => {
    const files = await tx
      .delete(file)
      .where(eq(file.createdById, id))
      .returning({ fileName: file.fileName });
    // Link imports never saved: their bytes have no `file` row, and the
    // cascade would drop the rows that explain them to reconciliation.
    const pending = await tx
      .delete(pendingPhoto)
      .where(eq(pendingPhoto.userId, id))
      .returning({ fileName: pendingPhoto.fileName });
    await tx.delete(user).where(eq(user.id, id));
    return [...files, ...pending].map((row) => row.fileName);
  });
}

/**
 * Serializes one owner's writes that must see each other for the rest of
 * the transaction. The lock is on the owner's user row, because what is
 * being decided may have no row of its own to lock yet (a user's first
 * plan, the outfit a double tap would save twice, the entry a re-plan is
 * about to swap). NO KEY UPDATE leaves the row's key alone, so it never
 * blocks another table's foreign key check against the user (a garment
 * insert, a wear), only another such write of the same owner. Taking it
 * again in the same transaction is free.
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
  const [locked] = await tx
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, ownerId))
    .for('no key update');
  if (!locked) throw new HttpError(404, 'Wardrobe not found');
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
 * OWNER_LOCK_TIMEOUT_MS (`SET LOCAL lock_timeout`, which in a savepoint
 * lasts to the caller's commit); a wait past it throws OwnerLockTimeout.
 *
 * Nested inside a caller's transaction, the lock belongs to the outermost
 * transaction once taken. But if this savepoint is the first to take it and
 * then rolls back (`work` throws) while the caller catches and carries on,
 * the lock goes with the savepoint: the rest of the caller's transaction
 * runs unlocked. No caller does that today; one that must keep going after
 * a failed owner write takes lockOwner itself first.
 */
export async function ownerTransaction<T>(
  db: Queryable,
  ownerId: number,
  writer: string,
  work: (tx: Queryable) => Promise<T>,
): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      // set_config(..., true) is SET LOCAL with a bound value.
      await tx.execute(
        sql`select set_config('lock_timeout', ${`${OWNER_LOCK_TIMEOUT_MS}ms`}, true)`,
      );
      await lockOwner(tx, ownerId);
      return work(tx);
    });
  } catch (error) {
    // A nested ownerTransaction already mapped it (and is not a pg error).
    if (!(error instanceof OwnerLockTimeout) && isLockTimeout(error)) {
      throw new OwnerLockTimeout(ownerId, writer);
    }
    throw error;
  }
}
