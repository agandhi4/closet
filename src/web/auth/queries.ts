import { eq, sql } from 'drizzle-orm';
import type { Db, Queryable } from '../../db/client';
import { file, pendingPhoto, user } from '../../db/schema';
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

/**
 * The one writer of a password. The new hash ends every session issued
 * before it (the fingerprint), and the same transaction revokes every
 * personal access token: a new password is how an account is taken back.
 */
export function updatePasswordHash(
  db: Db,
  id: number,
  passwordHash: string,
): Promise<AccountRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(user)
      .set({ password: passwordHash })
      .where(eq(user.id, id))
      .returning(accountColumns);
    await revokeAllTokens(tx, id);
    return row;
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
 * Deletes the user, their File rows and their pending link photos' rows in
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
 * the transaction: which plan is active (src/web/plans), whether an outfit
 * with a pick's garments already exists (pickIdea, src/web/gallery). The
 * lock is on the owner's user row, because what is being decided may have
 * no row of its own to lock yet (a user's first plan, the outfit a double
 * tap would save twice). NO KEY UPDATE leaves the row's key alone, so it
 * never blocks another table's foreign key check against the user (a
 * garment insert, a wear), only another such write of the same owner.
 */
export async function lockOwner(tx: Queryable, ownerId: number): Promise<void> {
  await tx
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, ownerId))
    .for('no key update');
}
