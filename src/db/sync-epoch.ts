import { sql } from 'drizzle-orm';
import type { Queryable } from './client';
import { syncEpoch } from './schema';

/**
 * Starts a new history for the changes feed (#652): every cursor answered
 * before it is a 410 `cursor_expired` from now on, so every device re-syncs
 * in full. Run after a database restore (the post-restore command, #653):
 * the restored rows carry the dump's epoch, the revisions of then and ids
 * the server will hand out again, which a device's cursor cannot tell from
 * the history it synced. It also ends every session cookie issued before it
 * (restoreEpochSql): a restore revives sessions a new password had ended.
 * Returns the new epoch.
 */
export async function bumpSyncEpoch(db: Queryable): Promise<string> {
  const [row] = await db
    .update(syncEpoch)
    .set({ epoch: sql`gen_random_uuid()`, bumpedAt: sql`now()` })
    .returning({ epoch: syncEpoch.epoch });
  // Migration 0061 writes the row; a database without it is not this schema.
  if (!row) throw new Error('sync_epoch has no row: is the schema current?');
  return row.epoch;
}

/**
 * What `restoreEpochSql` yields when the `sync_epoch` row is gone: not a
 * value any cookie carries (a uuid or absent), so a session check refuses
 * on it. The row is written by migration 0061 and never deleted, so its
 * absence is corruption, which the changes feed also refuses
 * (SyncEpochMissingError).
 */
export const SYNC_EPOCH_MISSING = '!missing';

/**
 * The epoch a restore last set, or null while the database was never
 * restored (the row's `bumped_at` is null): a scalar subquery over the one
 * `sync_epoch` row, for folding into a statement that reads something else.
 * Session cookies carry it as `sep` (src/web/auth/tokens.ts), so the bump
 * that expires every changes cursor also ends every session issued before
 * the restore (#908). Null rather than the migration's random epoch, so a
 * cookie from before epochs (no `sep`) stays valid until the first restore,
 * as a cursor does (isCurrentEpoch). No row at all yields
 * SYNC_EPOCH_MISSING, never null: a missing row must not pass for "never
 * restored".
 */
export const restoreEpochSql = sql<
  string | null
>`nullif(coalesce((select case when ${syncEpoch.bumpedAt} is null then '' else ${syncEpoch.epoch}::text end from ${syncEpoch}), ${SYNC_EPOCH_MISSING}), '')`;
