import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { file, user } from '../../db/schema';

/**
 * Account rows. Emails are compared case-insensitively and stored lower
 * case (normalizeEmail): rows written before 2026-09-26 may still carry
 * capitals, so lookups lower the column too. The unique constraint is still
 * on the raw column; a unique index on lower(email) is a later migration
 * (the data-model audit), and until then the register and update-email
 * routes check for a clash first.
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

/** `email` must already be normalized; the caller checked it is free. */
export async function insertUser(
  db: Db,
  email: string,
  passwordHash: string,
): Promise<AccountRow> {
  const [row] = await db
    .insert(user)
    .values({ email, password: passwordHash })
    .returning(accountColumns);
  return row;
}

export async function updatePasswordHash(
  db: Db,
  id: number,
  passwordHash: string,
): Promise<AccountRow> {
  const [row] = await db
    .update(user)
    .set({ password: passwordHash })
    .where(eq(user.id, id))
    .returning(accountColumns);
  return row;
}

export async function updateEmail(
  db: Db,
  id: number,
  email: string,
): Promise<void> {
  await db.update(user).set({ email }).where(eq(user.id, id));
}

/**
 * Deletes the user and their File rows in one transaction and returns the
 * stored names, which the caller unlinks after commit: the database cascade
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
    await tx.delete(user).where(eq(user.id, id));
    return files.map((row) => row.fileName);
  });
}

/** Postgres unique_violation: a concurrent write took the value first. */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  // drizzle wraps the driver's error as `cause`.
  while (current instanceof Error) {
    if ((current as Error & { code?: unknown }).code === '23505') return true;
    current = current.cause;
  }
  return false;
}
