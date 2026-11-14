import { sql } from 'drizzle-orm';
import type { Queryable } from './client';
import { syncEpoch } from './schema';

/**
 * Starts a new history for the changes feed (#652): every cursor answered
 * before it is a 410 `cursor_expired` from now on, so every device re-syncs
 * in full. Run after a database restore (the post-restore command, #653):
 * the restored rows carry the dump's epoch, the revisions of then and ids
 * the server will hand out again, which a device's cursor cannot tell from
 * the history it synced. Returns the new epoch.
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
