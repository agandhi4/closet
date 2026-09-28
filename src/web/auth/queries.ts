import { eq, sql } from 'drizzle-orm';
import type { Db, Queryable } from '../../db/client';
import { file, pendingPhoto, user } from '../../db/schema';
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
 */
export async function lockOwner(tx: Queryable, ownerId: number): Promise<void> {
  await tx
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, ownerId))
    .for('no key update');
}

/**
 * `work` in a transaction (a savepoint inside a caller's) that holds the
 * owner lock from its first statement: the one way to write
 * outfit_calendar, the week planner's tables, wardrobe plans and their
 * items (src/web/calendar/CLAUDE.md, Owner lock). The lock comes before
 * any row lock `work` takes (an outfit, a garment, an entry): the re-plan
 * takes those under it too, so taking one first could deadlock. A trip's
 * lock is the one taken before it (src/web/trips).
 */
export function ownerTransaction<T>(
  db: Queryable,
  ownerId: number,
  work: (tx: Queryable) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await lockOwner(tx, ownerId);
    return work(tx);
  });
}
