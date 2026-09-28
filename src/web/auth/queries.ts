import { and, eq, ne, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db, Queryable } from '../../db/client';
import { isLockTimeout, isUniqueViolation } from '../../db/errors';
import {
  file,
  pendingPhoto,
  type SharePermission,
  user,
  USER_EMAIL_UNIQUE,
} from '../../db/schema';
import { HttpError } from '../errors';
import { sharePermissionSql } from '../sharing/access';
import { t } from '../i18n';
import { type StoredPhoto, unkeyedPhoto } from '../files/image-variant';
import { STORED_PHOTO_COLUMNS } from '../files/queries';
import { revokeDevicesStatement } from '../push/queries';
import { revokeAllTokensStatement } from './personal-tokens';
import { PASSWORD_FINGERPRINT_LENGTH } from './tokens';

/**
 * Account rows. Emails are stored as normalizeEmail writes them (trimmed,
 * lower case; drizzle/0005 converted the older rows) and are unique
 * case-insensitively: the `user_lower_email_unique` index on lower(email),
 * which is also what the lookups below use. The two writers of an address
 * (insertUser, updateEmail) check it is free inside their own statement, so
 * a taken address raises nothing; only a concurrent write that wins the
 * race between that check and the index is the index's unique violation,
 * which they catch by name and answer the same way.
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

/**
 * The session's account as the resolver reads it on every request
 * (createSessionResolver, session.ts): `fingerprint` is the hash's suffix a
 * token carries as `pwf` (passwordFingerprint), cut in SQL so the 60
 * characters of the hash stay in the database. Only a route that checks the
 * current password (`config: { checksPassword: true }`) asks for the hash as
 * well, which then saves that route a second read of the same row; and a
 * request addressing another user's wardrobe (`?ownerId=`) reads its share
 * as `share` (null for none), which saves the access check its round trip
 * (shareToReadAhead, src/web/sharing/access.ts).
 */
export interface SessionAccount {
  id: number;
  email: string | null;
  fingerprint: string;
  password?: string;
  share?: SharePermission | null;
}

const sessionColumns = {
  id: user.id,
  email: user.email,
  fingerprint: sql<string>`right(${user.password}, ${PASSWORD_FINGERPRINT_LENGTH})`,
};

export async function findSessionAccount(
  db: Db,
  id: number,
  read: { withHash: boolean; shareOf?: number },
): Promise<SessionAccount | undefined> {
  const [row] = await db
    .select({
      ...sessionColumns,
      ...(read.withHash ? { password: user.password } : {}),
      ...(read.shareOf === undefined
        ? {}
        : { share: sharePermissionSql(read.shareOf, id) }),
    })
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
 * The new account, or undefined when `email` is taken, in one statement: the
 * insert selects its row only where no account has the address, so a taken
 * one raises nothing (a unique violation is a Postgres ERROR whose DETAIL
 * names the address). A sign-up that commits the same address between that
 * check and the index is the race's unique violation, caught by the index's
 * name and answered the same; any other error is rethrown. `email` must
 * already be normalized. Registration asks for no name; the seed's personas
 * have one (the share page says "Shared by" the first name).
 *
 * Raw SQL: Drizzle's insert-select must select every column, the serial id
 * included, which a select list cannot default.
 */
export async function insertUser(
  db: Queryable,
  email: string,
  passwordHash: string,
  name: { firstName?: string; lastName?: string } = {},
): Promise<AccountRow | undefined> {
  try {
    const { rows } = await db.execute<{
      id: number;
      email: string | null;
      password: string;
    }>(sql`
      insert into ${user} (email, password, first_name, last_name)
      select ${email}, ${passwordHash}, ${name.firstName ?? null}, ${name.lastName ?? null}
      where not exists (
        select 1 from ${user} where lower(${user.email}) = lower(${email})
      )
      returning id, email, password`);
    return rows[0];
  } catch (error) {
    if (isUniqueViolation(error, USER_EMAIL_UNIQUE)) return undefined;
    throw error;
  }
}

/** What a new password took away, besides every other session. */
export interface PasswordChange {
  account: AccountRow;
  revokedTokens: number;
  revokedDevices: number;
}

/**
 * The one writer of a password. The new hash ends every session issued
 * before it (the fingerprint), and the same statement revokes every
 * personal access token and every push subscription but `keepEndpoint`'s
 * (the device making the change, if it has one): a new password is how an
 * account is taken back, and a device signed out by it must stop receiving
 * the account's notifications at once (revokeDevicesStatement).
 *
 * One statement, not a transaction of three (#171): the token revocation
 * and the device removal are data-modifying CTEs beside the update, which
 * Postgres runs to completion whether or not the outer select reads them,
 * atomically with it. The three touch different tables, so none sees
 * another's change (a CTE's writes are invisible to its siblings). A
 * transaction cost five round trips to pgvault, this one.
 *
 * An account that no longer exists is an HttpError 404 (the route's page;
 * the CLI prints it), never a half-read row.
 */
export async function updatePasswordHash(
  db: Queryable,
  id: number,
  passwordHash: string,
  keepEndpoint?: string,
): Promise<PasswordChange> {
  const account = db
    .$with('account')
    .as(
      db
        .update(user)
        .set({ password: passwordHash })
        .where(eq(user.id, id))
        .returning(accountColumns),
    );
  const tokens = db
    .$with('revoked_tokens')
    .as(revokeAllTokensStatement(db, id));
  const devices = db
    .$with('revoked_devices')
    .as(revokeDevicesStatement(db, id, keepEndpoint));
  const [row] = await db
    .with(account, tokens, devices)
    .select({
      id: account.id,
      email: account.email,
      password: account.password,
      revokedTokens: sql`(select count(*) from ${tokens})`.mapWith(Number),
      revokedDevices: sql`(select count(*) from ${devices})`.mapWith(Number),
    })
    .from(account);
  // No row: the account is gone (deleted between the caller's read and
  // this), and the CTEs found nothing of it to revoke. A 404, as lockOwner.
  if (!row) throw new HttpError(404, 'Account not found');
  const { revokedTokens, revokedDevices, ...changed } = row;
  return { account: changed, revokedTokens, revokedDevices };
}

/**
 * Moves the account to `email` (already normalized); false when another
 * account has it. One statement, and a taken address raises nothing, as
 * insertUser: the update applies only where no other account holds the
 * address, and the race past that check is the index's violation, caught by
 * name. The account's own address, in any case, is no clash.
 */
export async function updateEmail(
  db: Db,
  id: number,
  email: string,
): Promise<boolean> {
  const other = alias(user, 'other');
  try {
    const updated = await db
      .update(user)
      .set({ email })
      .where(
        and(
          eq(user.id, id),
          notExists(
            db
              .select({ id: other.id })
              .from(other)
              .where(
                and(
                  eq(sql`lower(${other.email})`, sql`lower(${email})`),
                  ne(other.id, id),
                ),
              ),
          ),
        ),
      )
      .returning({ id: user.id });
    return updated.length > 0;
  } catch (error) {
    if (isUniqueViolation(error, USER_EMAIL_UNIQUE)) return false;
    throw error;
  }
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
