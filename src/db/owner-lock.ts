import { eq, exists, type SQL, sql } from 'drizzle-orm';
import type { Queryable } from './client';
import { user } from './schema';

/**
 * The owner lock's one statement shape (src/web/calendar/AGENTS.md, Owner
 * lock): the owner's `user` row FOR NO KEY UPDATE, then the transaction
 * marked as holding it. Every write to a synced table (docs/plans/
 * 2026-11-12-json-api.md section 7: the roots, their children, a garment's
 * photo row) takes it before any other row lock, so the sync triggers'
 * revision bump (#196a-2), an UPDATE of that same row, re-takes a lock
 * its transaction already holds and never waits mid-transaction.
 *
 * Used by lockOwner (src/web/auth/queries.ts, ownerTransaction's first
 * statement) and folded as the first CTE into a writer that is one
 * statement, or whose first statement locks another row (lockGarment,
 * lockTrip, the capsules' lockMembers, the cutout's row lock), so the
 * lock costs no round trip.
 *
 * **The mark is set only once the row is locked.** The inner select locks;
 * the outer select's set_config runs above its LockRows node, over the row
 * LockRows returned, so a wait that times out (and a savepoint that rolls
 * back and is caught) leaves no mark without the lock. lockTimeout's
 * set_config is the opposite: it must bound the wait, so it sits in the
 * inner scan's select list, computed below LockRows before the wait
 * (owner-lock.spec.ts EXPLAINs both).
 *
 * The mark (`closet.locked_owners`, SET LOCAL: ",<id>," per lock, gone at
 * the transaction's end, reverted with a savepoint rolled back) is read by
 * the sync guard (test/support/sync-guard.ts now, the sync triggers in
 * #196a-2). It catches a writer that forgot the lock, not one that sets
 * the mark by hand: forgetfulness, not malice.
 */
export const LOCKED_OWNERS_SETTING = 'closet.locked_owners';

const OWNER_LOCK_CTE = 'owner_lock';

/**
 * The lock as a select: a row (`id`) per owner `which` names that exists,
 * locked in id order (two lockers of several owners never deadlock) and
 * marked. `lockTimeout` ('5000ms') bounds every lock wait from this
 * statement to the transaction's end (SET LOCAL); without it the waits keep
 * the pool's statement_timeout, as the folded writers' did before #196a.
 */
function ownerLockSelect(db: Queryable, which: SQL, lockTimeout?: string) {
  const locked = db
    .select({
      id: user.id,
      ...(lockTimeout !== undefined && {
        lockTimeout:
          sql<string>`set_config('lock_timeout', ${lockTimeout}, true)`.as(
            'lock_timeout',
          ),
      }),
    })
    .from(user)
    .where(which)
    .orderBy(user.id)
    // Only the user rows: a subquery naming them (ownersLockCte) joins
    // other tables, whose rows are read, never locked.
    .for('no key update', { of: user })
    .as('owner_row');
  return db
    .select({
      id: locked.id,
      marked:
        sql<string>`set_config(${LOCKED_OWNERS_SETTING}, coalesce(current_setting(${LOCKED_OWNERS_SETTING}, true), '') || ',' || ${locked.id} || ',', true)`.as(
          'marked',
        ),
    })
    .from(locked);
}

/** `owner_lock` (ownerLockSelect) as a query builder's CTE: `db.with(lock)`. */
export function ownerLockCte(
  db: Queryable,
  ownerId: number,
  lockTimeout?: string,
) {
  return db
    .$with(OWNER_LOCK_CTE)
    .as(ownerLockSelect(db, eq(user.id, ownerId), lockTimeout));
}

/**
 * ownerLockCte for the owners of a set of rows (`ownerIds`, a subquery of
 * owner ids): each locked, in id order, and marked. A job's write over
 * several owners' rows (the cutout retry) or over a row whose owner it
 * learns from the row (a garment's photo).
 */
export function ownersLockCte(db: Queryable, ownerIds: SQL) {
  return db
    .$with(OWNER_LOCK_CTE)
    .as(ownerLockSelect(db, sql`${user.id} in (${ownerIds})`));
}

/**
 * `owner_lock as (...)`, the same CTE for a statement written in SQL
 * (`with ${ownerLockSql(db, id)}, ...`); its writes ask
 * `exists (select 1 from owner_lock)` (OWNER_LOCKED).
 */
export function ownerLockSql(db: Queryable, ownerId: number): SQL {
  return sql`${sql.identifier(OWNER_LOCK_CTE)} as (${ownerLockSelect(db, eq(user.id, ownerId)).getSQL()})`;
}

/** ownerLocked in SQL, for a statement that names the CTE ownerLockSql wrote. */
export const OWNER_LOCKED = sql`exists (select 1 from ${sql.identifier(OWNER_LOCK_CTE)})`;

export type OwnerLockCte = ReturnType<typeof ownerLockCte>;

/**
 * `exists (select 1 from owner_lock)`: uncorrelated, so Postgres runs it
 * once as an InitPlan before the statement scans anything, which is what
 * puts the owner lock ahead of the rows the statement locks or writes. A
 * missing owner (an account deleted meanwhile) makes the statement change
 * nothing, which every caller already answers as not found.
 */
export function ownerLocked(db: Queryable, lock: OwnerLockCte) {
  return exists(db.select({ one: sql`1` }).from(lock));
}

/**
 * The locked owner's id, `(select id from owner_lock)`, for an INSERT's
 * owner column: the value is what runs the CTE, before the row is formed.
 * A missing owner inserts a null owner, refused by its NOT NULL as the
 * foreign key refused it before.
 */
export function lockedOwnerId(lock: OwnerLockCte) {
  return sql<number>`(select ${lock.id} from ${lock})`;
}
