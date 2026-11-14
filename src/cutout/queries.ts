import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  min,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { Db, Queryable } from '../db/client';
import { ownersLockCte } from '../db/owner-lock';
import { file, garment } from '../db/schema';
import type { PendingCutouts } from '../metrics/metrics';
import { currentRequest } from '../request-context';
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
  /**
   * The owner of the garment showing the photo, as locked or read with the
   * row (lockCutoutRow); null when no garment shows it. applyCutoutEvent
   * writes only while that is still so.
   */
  lockedOwner: number | null;
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

/**
 * The owners of the garments showing these photos: a garment's photo row
 * is synced data (its version, cutout status and missing mark), so its
 * writers take that owner's lock first (src/db/owner-lock.ts): the cutout
 * writers here and reconciliation's missing marks (writeMissingMarks). A
 * selfie's, a look's or an orphan's photo has none, and its writes lock no
 * owner. `fileIds` is a subquery or a list of ids.
 *
 * A photo's owner never changes while another transaction can see it: a
 * garment only ever points at a `file` row its own transaction inserted
 * (replacePhotoRow, a pending photo's claim, a clone), and the row goes in
 * the transaction that stops pointing at it. So the owner read before the
 * lock is the owner under it; applyCutoutEvent still checks, in its write.
 */
export function garmentOwnersOf(fileIds: SQL): SQL {
  return sql`select ${garment.ownerId} from ${garment} where ${garment.photoId} in (${fileIds})`;
}

/**
 * The owner of the garment showing the statement's `file` row. Written
 * with its tables: Drizzle drops them from a single-table select's SQL
 * fields (src/db/AGENTS.md), which would compare garment's own columns.
 */
const garmentOwnerSql = sql<
  number | null
>`(select g.owner_id from ${garment} g where g.photo_id = ${sql.raw('"file"."id"')})`;

/**
 * The photo's cutout state, its row locked until the transaction ends, its
 * garment's owner locked before it (garmentOwnersOf). `lockedOwner` is the
 * owner locked, null without one: computed in the scan below the row's
 * LockRows, so the owner lock comes first (owner-lock.spec.ts EXPLAINs it).
 */
export async function lockCutoutRow(
  tx: Queryable,
  fileName: string,
): Promise<CutoutRow | undefined> {
  const [row] = await lockCutoutRowQuery(tx, fileName);
  return row;
}

/** lockCutoutRow's statement, exported for owner-lock.spec.ts. */
export function lockCutoutRowQuery(tx: Queryable, fileName: string) {
  const lock = ownersLockCte(
    tx,
    garmentOwnersOf(
      sql`select ${file.id} from ${file} where ${file.fileName} = ${fileName}`,
    ),
  );
  return tx
    .with(lock)
    .select({
      ...stateColumns,
      lockedOwner: sql<number | null>`(select max(l.id) from ${lock} l)`,
    })
    .from(file)
    .where(eq(file.fileName, fileName))
    .for('update', { of: file });
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
      ...(next.queued && {
        cutoutRequestedAt: new Date(),
        cutoutRequestId: currentRequest()?.requestId ?? null,
      }),
    })
    .where(
      and(
        eq(file.id, row.id),
        // The photo's garment owner is the one locked (lockCutoutRow),
        // read again by this statement under the row's lock.
        sql`${garmentOwnerSql} is not distinct from ${row.lockedOwner}`,
      ),
    );
  // A released row is claimable again: tell the other servers, rather than
  // leave it to their poll.
  const written = await update.returning({
    notified:
      next.queued || event.type === 'release'
        ? CUTOUT_QUEUED_NOTIFY
        : sql<string>`''`,
  });
  if (written.length === 0) {
    // garmentOwnersOf says why this cannot happen; written anyway, it
    // would be a synced write without its owner's lock.
    throw new Error(
      `Photo ${row.fileName} changed owner under its row lock: ${event.type} not written`,
    );
  }
  return next;
}

/**
 * applyCutoutEvent for many rows at once, locked by the caller's
 * transaction: the machine decides each row (transition), and the accepted
 * ones are written in one statement (an UPDATE from a VALUES list), with
 * the same columns applyCutoutEvent writes. For an event that brings no
 * bytes and takes no lease: the nightly retry (retryFailedCutouts, #173:
 * it was a transaction of four statements per failed photo). Each row's
 * transition, in the rows' order.
 */
export async function applyCutoutEventToRows(
  tx: Queryable,
  rows: readonly CutoutRow[],
  event: Extract<CutoutEvent, { type: 'retry' }>,
): Promise<Transition[]> {
  const moves = rows.map((row) => ({ row, next: transition(row, event) }));
  const values = moves.flatMap(({ row, next }) =>
    next.ok
      ? [
          sql`(${row.id}::int, ${next.state.status}::text, ${next.state.version}::int, ${next.state.attempts}::int, ${next.state.jobVersion}::int, ${next.state.variantKey}::text)`,
        ]
      : [],
  );
  if (values.length > 0) {
    // A retry queues every row it accepts: each is claimable, so the queues
    // are told (Postgres folds the repeats into one notification).
    await tx.execute(sql`
      update ${file} set
        cutout_status = next.status,
        version = next.version,
        cutout_attempts = next.attempts,
        cutout_job_version = next.job_version,
        cutout_worker = null,
        cutout_started_at = null,
        variant_key = next.variant_key,
        cutout_requested_at = ${new Date()}::timestamptz,
        cutout_request_id = null
      from (values ${sql.join(values, sql`, `)})
        as next(id, status, version, attempts, job_version, variant_key)
      where ${file.id} = next.id
      returning ${CUTOUT_QUEUED_NOTIFY}`);
  }
  return moves.map(({ next }) => next);
}

/**
 * The rows of `fileNames`, locked until the transaction ends, in id order
 * (the order every batch locks in, so two never deadlock).
 */
export function lockCutoutRows(
  tx: Queryable,
  fileNames: readonly string[],
): Promise<CutoutRow[]> {
  return lockCutoutRowsQuery(tx, fileNames);
}

/** lockCutoutRows' statement, exported for owner-lock.spec.ts, which EXPLAINs it. */
export function lockCutoutRowsQuery(
  tx: Queryable,
  fileNames: readonly string[],
) {
  // Their garments' owners first, in id order (garmentOwnersOf).
  const lock = ownersLockCte(
    tx,
    garmentOwnersOf(
      sql`select ${file.id} from ${file} where ${inArray(file.fileName, [...fileNames])}`,
    ),
  );
  return tx
    .with(lock)
    .select({
      ...stateColumns,
      // The lock's own column is what runs it, in the scan below the
      // rows' LockRows (as lockCutoutRow's); each row's owner is read
      // beside it.
      lockedOwner: sql<
        number | null
      >`(select max(l.id) from ${lock} l where l.id = ${garmentOwnerSql})`,
    })
    .from(file)
    .where(inArray(file.fileName, [...fileNames]))
    .orderBy(asc(file.id))
    .for('update', { of: file });
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

// A ready or edited cutout keeps its status (rederive); any other is the
// household's choice from now on (edit). Unwanted refuses both.
function repointEvent(row: CutoutRow, variantKey: string | null): CutoutEvent {
  return row.status === 'ready' || row.status === 'edited'
    ? { type: 'rederive', fromKey: row.variantKey, variantKey }
    : { type: 'edit', variantKey };
}

/** What repointCutoutRow did: the row as locked, and the machine's answer. */
export type RepointedRow =
  | { gone: true }
  | {
      gone: false;
      row: CutoutRow;
      /** null: the row already pointed at the key, so no event applied. */
      next: Transition | null;
      /** Its missing mark was cleared (#653). */
      unmarked: boolean;
    };

/**
 * The operator's repoint (`maintenance:repoint-cutout`, #653): the row
 * pointed at a nobg and thumb the caller found stored under `variantKey`,
 * in one transaction under the garment owner's and the row's locks
 * (lockCutoutRow). A ready or edited row takes `rederive` (its status
 * kept), any other `edit`, which no job result then replaces: a running
 * job's result is refused. Once the row points at the key, its missing
 * mark is cleared in the same transaction: its files are stored.
 */
export function repointCutoutRow(
  db: Db,
  fileName: string,
  variantKey: string | null,
): Promise<RepointedRow> {
  return db.transaction(async (tx): Promise<RepointedRow> => {
    const row = await lockCutoutRow(tx, fileName);
    if (!row) return { gone: true };
    const next =
      row.variantKey === variantKey
        ? null
        : await applyCutoutEvent(tx, row, repointEvent(row, variantKey));
    if (next && !next.ok) return { gone: false, row, next, unmarked: false };
    const cleared = await tx
      .update(file)
      .set({ originalMissingSince: null })
      .where(and(eq(file.id, row.id), isNotNull(file.originalMissingSince)))
      .returning({ id: file.id });
    return { gone: false, row, next, unmarked: cleared.length > 0 };
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
  /** The request that queued it, if one did: the job's parent_request_id. */
  requestId?: string;
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
        requestId: file.cutoutRequestId,
        garmentId: garment.id,
        // Read, not locked: start changes neither the version nor the
        // status, so it is no synced write (garmentOwnersOf).
        lockedOwner: garment.ownerId,
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
      requestId: row.requestId ?? undefined,
      garmentId: row.garmentId,
      lapsedWorker: row.worker,
    };
  });
}

/**
 * Photos waiting for the queue, a job in flight included, and when the
 * oldest was requested: its depth and age metrics (Metrics.trackCutoutQueue).
 */
export async function countPendingCutouts(db: Db): Promise<PendingCutouts> {
  const [row] = await db
    .select({ depth: count(), oldestRequestedAt: min(file.cutoutRequestedAt) })
    .from(file)
    .where(eq(file.cutoutStatus, 'pending'));
  return row;
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
