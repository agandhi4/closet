/**
 * Where a photo's background-removed cutout stands, and the one function
 * that decides every change to it. Stored on the photo's `file` row
 * (cutout_status, cutout_attempts, cutout_job_version; src/db/schema.ts)
 * and changed only through applyCutoutEvent (src/cutout/queries.ts), which
 * locks the row, asks transition() and writes what it answers. Nothing else
 * writes those columns.
 *
 *   none ──request──▶ pending ──succeed──▶ ready
 *                      ▲  │  └──fail─────▶ failed
 *                      │  └─start (a job begins: attempts + 1)
 *                      └──retry── pending | failed
 *   any ──edit──▶ edited        (the user saved a mask: always wins)
 *
 * - none: no server cutout was asked for (client mode, or a photo from
 *   before server mode; a browser-made cutout may exist).
 * - pending: queued (the database is the queue, src/cutout/queue.ts); a
 *   running job is still pending, with cutout_job_version set by start.
 * - ready / failed: the job's result. failed shows the original and a
 *   "Try again"; the nightly retry requeues failed rows under 3 attempts.
 * - edited: the user's mask; no job result ever replaces it.
 *
 * A job's result (succeed, fail) is accepted only while the row is pending
 * and still on the photo version the job started for: a result for a
 * replaced, edited or requeued photo is discarded, never written.
 */

export const CUTOUT_STATUSES = [
  'none',
  'pending',
  'ready',
  'failed',
  'edited',
] as const;

export type CutoutStatus = (typeof CUTOUT_STATUSES)[number];

/** The nightly retry requeues a failed cutout only below this many runs. */
export const MAX_CUTOUT_ATTEMPTS = 3;

export interface CutoutState {
  status: CutoutStatus;
  /** The photo's version (file.version): bumped whenever cutout bytes change. */
  version: number;
  /** Jobs started since the photo was stored. */
  attempts: number;
  /** The photo version the running job started for; null when none runs. */
  jobVersion: number | null;
}

export type CutoutEvent =
  /** A photo was stored in server mode: ask for a server cutout. */
  | { type: 'request' }
  /** "Try again" or the nightly retry. */
  | { type: 'retry' }
  /** The queue picked the row up. */
  | { type: 'start' }
  /** The job's cutout, for the photo version it started for. */
  | { type: 'succeed'; jobVersion: number }
  | { type: 'fail'; jobVersion: number }
  /** The user saved a mask in the mask editor. */
  | { type: 'edit' };

export type CutoutEventType = CutoutEvent['type'];

export type Transition =
  | {
      ok: true;
      state: CutoutState;
      /** Entered the queue: its place (cutout_requested_at) is now. */
      queued: boolean;
    }
  | {
      ok: false;
      /**
       * not-allowed: the status does not take this event (a result for a
       * row that is no longer pending, a retry of a ready cutout).
       * stale: a job result for another photo version than the row's.
       */
      reason: 'not-allowed' | 'stale';
    };

/** The statuses each event applies to; any other refuses it (not-allowed). */
const ACCEPTED_FROM: Record<CutoutEventType, readonly CutoutStatus[]> = {
  request: ['none'],
  retry: ['pending', 'failed'],
  start: ['pending'],
  succeed: ['pending'],
  fail: ['pending'],
  edit: CUTOUT_STATUSES,
};

/** The state after `event`, or why the event does not apply. Pure. */
export function transition(state: CutoutState, event: CutoutEvent): Transition {
  if (!ACCEPTED_FROM[event.type].includes(state.status)) {
    return { ok: false, reason: 'not-allowed' };
  }
  if (
    (event.type === 'succeed' || event.type === 'fail') &&
    (state.jobVersion !== event.jobVersion ||
      state.version !== event.jobVersion)
  ) {
    return { ok: false, reason: 'stale' };
  }
  return {
    ok: true,
    state: nextState(state, event),
    queued: event.type === 'request' || event.type === 'retry',
  };
}

// The accepted event's effect on the row.
function nextState(state: CutoutState, event: CutoutEvent): CutoutState {
  switch (event.type) {
    case 'request':
    case 'retry':
      // A job still running for a retried row finds jobVersion cleared and
      // its result is discarded; the requeued row runs again.
      return { ...state, status: 'pending', jobVersion: null };
    case 'start':
      return {
        ...state,
        attempts: state.attempts + 1,
        jobVersion: state.version,
      };
    case 'succeed':
      // New cutout bytes under the same name: a new version URL.
      return {
        ...state,
        status: 'ready',
        version: state.version + 1,
        jobVersion: null,
      };
    case 'fail':
      return { ...state, status: 'failed', jobVersion: null };
    case 'edit':
      return {
        ...state,
        status: 'edited',
        version: state.version + 1,
        jobVersion: null,
      };
  }
}

/**
 * The cutout columns of a photo row about to be inserted: `status` is what
 * the new row starts as (none, or the result of `request`; a copied photo
 * takes its source's status, and a pending copy is queued in its own
 * right).
 */
export interface InitialCutoutColumns {
  cutoutStatus: CutoutStatus;
  cutoutAttempts: number;
  cutoutJobVersion: null;
  cutoutRequestedAt: Date | null;
}

export function initialCutoutState(status: CutoutStatus): InitialCutoutColumns {
  return {
    cutoutStatus: status,
    cutoutAttempts: 0,
    cutoutJobVersion: null,
    cutoutRequestedAt: status === 'pending' ? new Date() : null,
  };
}
