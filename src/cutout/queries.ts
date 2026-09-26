import { and, asc, eq, lt } from 'drizzle-orm';
import type { Db, Queryable } from '../db/client';
import { file, garment } from '../db/schema';
import {
  type CutoutEvent,
  type CutoutState,
  transition,
  type Transition,
} from './state';

/**
 * The cutout columns of the `file` table, written only here: every change
 * locks the row, asks the state machine (transition, ./state.ts) and writes
 * the state it answers. Photos (the cutout bytes), the queue, the retry
 * route and the nightly retry all go through applyCutoutEvent.
 */

export interface CutoutRow extends CutoutState {
  id: number;
  fileName: string;
}

/** What an event did: the transition, or `gone` when the photo row is gone. */
export type CutoutOutcome = Transition | { ok: false; reason: 'gone' };

const stateColumns = {
  id: file.id,
  fileName: file.fileName,
  status: file.cutoutStatus,
  version: file.version,
  attempts: file.cutoutAttempts,
  jobVersion: file.cutoutJobVersion,
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
 * next state when the machine allows it, nothing otherwise. `effect` runs
 * once the machine has accepted and before the row is written: Photos
 * stores the cutout bytes and thumb there, so they are on disk before any
 * client can see the new version, and never written for a refused event.
 */
export async function applyCutoutEvent(
  tx: Queryable,
  row: CutoutRow,
  event: CutoutEvent,
  effect?: () => Promise<void>,
): Promise<Transition> {
  const next = transition(row, event);
  if (!next.ok) return next;
  await effect?.();
  await tx
    .update(file)
    .set({
      cutoutStatus: next.state.status,
      version: next.state.version,
      cutoutAttempts: next.state.attempts,
      cutoutJobVersion: next.state.jobVersion,
      ...(next.queued && { cutoutRequestedAt: new Date() }),
    })
    .where(eq(file.id, row.id));
  return next;
}

/** applyCutoutEvent in a transaction of its own, for events that write no bytes. */
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
}

/**
 * Starts the oldest pending cutout: `start` counts the attempt and records
 * the photo version. The row stays pending while the job runs. SKIP LOCKED
 * lets a second server on the database (an overlapping deploy) take another
 * row instead of waiting; a row both run anyway is written once, the
 * other's result being refused by the machine.
 */
export function claimNextCutout(db: Db): Promise<CutoutJob | undefined> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        ...stateColumns,
        requestedAt: file.cutoutRequestedAt,
        garmentId: garment.id,
      })
      .from(file)
      .leftJoin(garment, eq(garment.photoId, file.id))
      .where(eq(file.cutoutStatus, 'pending'))
      .orderBy(asc(file.cutoutRequestedAt), asc(file.id))
      .limit(1)
      .for('update', { of: file, skipLocked: true });
    if (!row) return undefined;
    const started = await applyCutoutEvent(tx, row, { type: 'start' });
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
    };
  });
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
