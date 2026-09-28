import { and, asc, count, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { Db, Queryable } from '../db/client';
import { file, garment } from '../db/schema';
import { CUTOUT_TIMEOUT_MS } from './runner';
import {
  type CutoutEvent,
  type CutoutState,
  transition,
  type Transition,
} from './state';

/**
 * The cutout columns of the `file` table, written only here: every change
 * locks the row, asks the state machine (transition, ./state.ts) and writes
 * the state it answers. Photos (the pointer to cutout bytes it stored
 * first), the queue, the retry route and the nightly retry all go through
 * applyCutoutEvent.
 */

/**
 * How long a started job holds its row before another server may claim it
 * again (#45). Longer than the longest job: the queue waits for the model
 * file before claiming (CutoutRunner.ready), so a job is the photo's decode,
 * one model run the runner kills at CUTOUT_TIMEOUT_MS (the model load
 * included) and the cutout's write, a few seconds beside it. Five times the
 * model's limit leaves room for a loaded CPU. Its only cost is how late a
 * crashed server's job runs again: a job cut short by a shutdown releases
 * its lease, and every result clears it.
 */
export const CUTOUT_LEASE_MS = 5 * CUTOUT_TIMEOUT_MS;

export interface CutoutRow extends CutoutState {
  id: number;
  fileName: string;
}

/**
 * The channel every write that queues a cutout notifies (CUTOUT_QUEUED_NOTIFY)
 * and the queue's listener (src/cutout/listener.ts) listens on. Channels are
 * per database, so this one name is safe on the shared pgvault instance.
 */
export const CUTOUT_QUEUED_CHANNEL = 'closet_cutout_queued';

/**
 * Tells every listening queue, in this process or another (a CLI, a second
 * server during an overlapping deploy), that a row became pending. Inside a
 * transaction Postgres delivers it only on commit, so a listener never looks
 * before the row is visible, and a rollback sends nothing. An expression for
 * the RETURNING of the write that makes a row claimable, so the notification
 * costs no statement of its own (#162): applyCutoutEvent's update (request,
 * retry, release) and insertPhotoRow's insert (a new pending photo). The
 * payload is empty so Postgres folds a transaction's repeats into one.
 */
export const CUTOUT_QUEUED_NOTIFY = sql<string>`pg_notify(${CUTOUT_QUEUED_CHANNEL}, '')`;

/** What an event did: the transition, or `gone` when the photo row is gone. */
export type CutoutOutcome = Transition | { ok: false; reason: 'gone' };

const stateColumns = {
  id: file.id,
  fileName: file.fileName,
  status: file.cutoutStatus,
  version: file.version,
  attempts: file.cutoutAttempts,
  jobVersion: file.cutoutJobVersion,
  worker: file.cutoutWorker,
  variantKey: file.variantKey,
};

/** The photo's cutout state, its row locked until the transaction ends. */
export async function lockCutoutRow(
  tx: Queryable,
  fileName: string,
): Promise<CutoutRow | undefined> {
  const [row] = await tx
    .select(stateColumns)
    .from(file)
    .where(eq(file.fileName, fileName))
    .for('update');
  return row;
}

/**
 * Applies `event` to a row locked by the caller's transaction: writes the
 * next state when the machine allows it, nothing otherwise. Database work
 * only: the transaction holds the row's lock, and the server pool ends a
 * session idle in a transaction (a slow NFS write would be one). The bytes
 * a succeed or edit brings are stored before the transaction, under the
 * key the event carries (Photos.writeCutout).
 */
export async function applyCutoutEvent(
  tx: Queryable,
  row: CutoutRow,
  event: CutoutEvent,
): Promise<Transition> {
  const next = transition(row, event);
  if (!next.ok) return next;
  const update = tx
    .update(file)
    .set({
      cutoutStatus: next.state.status,
      version: next.state.version,
      cutoutAttempts: next.state.attempts,
      cutoutJobVersion: next.state.jobVersion,
      // Only start leases (nextState): a lease is always taken now.
      cutoutWorker: next.state.worker,
      cutoutStartedAt: next.state.worker === null ? null : sql`now()`,
      variantKey: next.state.variantKey,
      ...(next.queued && { cutoutRequestedAt: new Date() }),
    })
    .where(eq(file.id, row.id));
  // A released row is claimable again: tell the other servers, rather than
  // leave it to their poll.
  if (next.queued || event.type === 'release') {
    await update.returning({ notified: CUTOUT_QUEUED_NOTIFY });
  } else {
    await update;
  }
  return next;
}

/** applyCutoutEvent in a transaction of its own, for events that bring no bytes. */
export function recordCutoutEvent(
  db: Db,
  fileName: string,
  event: CutoutEvent,
): Promise<CutoutOutcome> {
  return db.transaction(async (tx) => {
    const row = await lockCutoutRow(tx, fileName);
    if (!row) return { ok: false, reason: 'gone' } as const;
    return applyCutoutEvent(tx, row, event);
  });
}

/** A started job: the row it was claimed from, for the log and the result. */
export interface CutoutJob {
  fileId: number;
  fileName: string;
  /** The photo version the job runs for (its `succeed`/`fail` carry it). */
  jobVersion: number;
  attempts: number;
  /** When the row entered the queue (the queue wait in the log). */
  requestedAt: Date | null;
  /** The garment showing the photo; null when none does (any more). */
  garmentId: number | null;
  /** The worker whose lapsed lease this claim took over: it crashed or hung. */
  lapsedWorker: string | null;
}

/**
 * Starts the oldest pending cutout no live job holds, for `worker`: `start`
 * counts the attempt, records the photo version and leases the row, all in
 * this transaction. The row stays pending while the job runs, so a crashed
 * server's job is claimed again once its lease is older than
 * CUTOUT_LEASE_MS. Two servers on one database (an overlapping deploy)
 * never run one photo together: SKIP LOCKED makes the second skip a row the
 * first is claiming, and the lease makes it skip one the first has started.
 * The lease's age is the database's clock, so the servers' clocks never
 * matter.
 */
export function claimNextCutout(
  db: Db,
  worker: string,
): Promise<CutoutJob | undefined> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        ...stateColumns,
        requestedAt: file.cutoutRequestedAt,
        garmentId: garment.id,
      })
      .from(file)
      .leftJoin(garment, eq(garment.photoId, file.id))
      .where(
        and(
          eq(file.cutoutStatus, 'pending'),
          or(
            isNull(file.cutoutStartedAt),
            lt(
              file.cutoutStartedAt,
              sql`now() - make_interval(secs => ${CUTOUT_LEASE_MS / 1000})`,
            ),
          ),
        ),
      )
      .orderBy(asc(file.cutoutRequestedAt), asc(file.id))
      .limit(1)
      .for('update', { of: file, skipLocked: true });
    if (!row) return undefined;
    const started = await applyCutoutEvent(tx, row, { type: 'start', worker });
    if (!started.ok) {
      throw new Error(`Pending cutout ${row.fileName} refused start`);
    }
    return {
      fileId: row.id,
      fileName: row.fileName,
      jobVersion: started.state.jobVersion!,
      attempts: started.state.attempts,
      requestedAt: row.requestedAt,
      garmentId: row.garmentId,
      lapsedWorker: row.worker,
    };
  });
}

/** Photos waiting for the queue, a job in flight included: its depth metric. */
export async function countPendingCutouts(db: Db): Promise<number> {
  const [row] = await db
    .select({ pending: count() })
    .from(file)
    .where(eq(file.cutoutStatus, 'pending'));
  return row.pending;
}

/** Stored names of failed cutouts with fewer than `maxAttempts` runs. */
export async function retryableCutouts(
  db: Db,
  maxAttempts: number,
): Promise<string[]> {
  const rows = await db
    .select({ fileName: file.fileName })
    .from(file)
    .where(
      and(
        eq(file.cutoutStatus, 'failed'),
        lt(file.cutoutAttempts, maxAttempts),
      ),
    )
    .orderBy(asc(file.id));
  return rows.map((row) => row.fileName);
}
