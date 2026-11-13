import { LOCKED_OWNERS_SETTING } from '../../src/db/owner-lock';

/**
 * The sync guard, test-only (#196a-1): a raising copy of the check the
 * sync triggers make in #196a-2, installed on the migrated template
 * (scratch-database.ts) and so on every integration spec's and page
 * audit's database, never by a migration. A write to a synced table whose
 * transaction does not hold its owner's lock (ownerLockCte's mark,
 * src/db/owner-lock.ts) raises, so ci-db proves every writer (routes, MCP,
 * the seed, maintenance, the re-plan, the reminders) takes the owner lock
 * first one release before the strict triggers ship.
 *
 * BEFORE row triggers, as the sync triggers will be: they run with the row
 * locked and the statement's InitPlans (a folded owner lock) already run,
 * so a lock taken later in the same statement does not pass. An owner that
 * no longer exists (an account deleted in the transaction, its cascade)
 * and a child whose parent went first in a cascade pass: the sync triggers
 * stamp nothing there either.
 *
 * Spec fixtures that write synced rows through t.db take the lock like any
 * writer (asOwner, harness.ts).
 */

/** A synced table: whose owner column, or the parent row that has it. */
type GuardedTable =
  | { table: string; owner: string }
  | {
      table: string;
      /** The row's column naming the parent... */
      key: string;
      /** ...matched against this column of `parent`, whose `parentOwner` is the owner. */
      parent: string;
      match: string;
      parentOwner: string;
      /** Only these UPDATEs count (the photo's version and cutout status). */
      updateWhen?: string;
    };

/**
 * Every synced table (docs/plans/2026-11-12-json-api.md section 7), the
 * list #196a-2's sync-triggers.spec.ts holds the triggers to. Inspiration
 * (#22) is not synced yet.
 */
export const SYNCED_TABLES: readonly GuardedTable[] = [
  { table: 'garment', owner: 'owner_id' },
  { table: 'outfit', owner: 'owner_id' },
  { table: 'outfit_calendar', owner: 'owner_id' },
  { table: 'garment_wear', owner: 'owner_id' },
  { table: 'selfie', owner: 'owner_id' },
  { table: 'capsule', owner: 'owner_id' },
  { table: 'trip', owner: 'owner_id' },
  { table: 'week_plan', owner: 'owner_id' },
  { table: 'brand_size', owner: 'user_id' },
  { table: 'style_profile', owner: 'user_id' },
  { table: 'body_measurements', owner: 'user_id' },
  { table: 'week_template', owner: 'user_id' },
  child('outfit_slot', 'outfit_id', 'outfit'),
  child('trip_item', 'trip_id', 'trip'),
  child('trip_outfit', 'trip_id', 'trip'),
  child('trip_garment_packed', 'trip_id', 'trip'),
  child('capsule_garment', 'capsule_id', 'capsule'),
  child('week_plan_entry', 'week_plan_id', 'week_plan'),
  child('garment_repair', 'garment_id', 'garment'),
  {
    // A garment's photo: the garment whose photo_id it is. A selfie's, a
    // look's or an orphan's photo has no garment and is not synced.
    table: 'file',
    key: 'id',
    parent: 'garment',
    match: 'photo_id',
    parentOwner: 'owner_id',
    updateWhen:
      'old.version is distinct from new.version or old.cutout_status is distinct from new.cutout_status',
  },
];

function child(table: string, key: string, parent: string): GuardedTable {
  return { table, key, parent, match: 'id', parentOwner: 'owner_id' };
}

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

function triggersOf(entry: GuardedTable): string {
  const name = `closet_test_sync_guard_${entry.table}`;
  const args =
    'owner' in entry
      ? literal(entry.owner)
      : [entry.key, entry.parent, entry.match, entry.parentOwner]
          .map(literal)
          .join(', ');
  const when =
    'updateWhen' in entry && entry.updateWhen
      ? `before update on "${entry.table}" for each row when (${entry.updateWhen})`
      : `before insert or update or delete on "${entry.table}" for each row`;
  return `create trigger ${name} ${when} execute function closet_test_sync_guard(${args});`;
}

/** The guard's DDL: one function, a trigger per synced table. Part of the template's name. */
export const SYNC_GUARD_SQL = `
create function closet_test_sync_guard() returns trigger
language plpgsql as $guard$
declare
  written jsonb;
  key integer;
  owner integer;
begin
  if tg_op = 'DELETE' then written := to_jsonb(old); else written := to_jsonb(new); end if;
  key := (written ->> tg_argv[0])::integer;
  if tg_nargs = 1 then
    owner := key;
  else
    execute format('select %I from %I where %I = $1', tg_argv[3], tg_argv[1], tg_argv[2])
      into owner using key;
  end if;
  if owner is not null
    and position(',' || owner || ',' in coalesce(current_setting(${literal(LOCKED_OWNERS_SETTING)}, true), '')) = 0
    and exists (select 1 from "user" where id = owner)
  then
    raise exception 'sync guard: % % for owner % without its owner lock (ownerLockCte, src/db/owner-lock.ts)',
      tg_op, tg_table_name, owner;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$guard$;
${SYNCED_TABLES.map(triggersOf).join('\n')}
`;
