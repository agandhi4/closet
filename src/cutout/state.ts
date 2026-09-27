/**
 * Where a photo's background-removed cutout stands, and the one function
 * that decides every change to it. Stored on the photo's `file` row
 * (cutout_status, cutout_attempts, cutout_job_version, cutout_worker;
 * src/db/schema.ts) and changed only through applyCutoutEvent
 * (src/cutout/queries.ts), which locks the row, asks transition() and
 * writes what it answers. Nothing else writes those columns.
 *
 *   none ──request──▶ pending ──succeed──▶ ready
 *                      ▲  │  └──fail─────▶ failed
 *                      │  ├─start   (a job begins: attempts + 1, leased)
 *                      │  └─release (the job ended without a result: lease freed)
 *                      └──retry── failed
 *   any but unwanted ──edit──▶ edited   (the user saved a mask: always wins)
 *   unwanted                            (terminal: no event applies, so
 *                                        never queued, claimed or leased)
 *
 * - none: no server cutout was asked for: a photo stored before
 *   background removal moved to the server (its cutout, if any, was made
 *   in the browser).
 * - unwanted: the photo keeps its background on purpose (an outfit selfie,
 *   #19, src/web/selfies): stored so, and never queued, retried or edited,
 *   so no job, backfill or mask can ever cut the person out of the room.
 *   (none, by contrast, still takes request.)
 * - pending: queued (the database is the queue, src/cutout/queue.ts); a
 *   running job is still pending, with cutout_job_version and its lease
 *   (cutout_worker) set by start. The lease is what keeps a second server
 *   from running the same photo; it lapses on its own after
 *   CUTOUT_LEASE_MS (queries.ts), so a crashed server's job runs again.
 *   Every event that ends or abandons the job clears it.
 * - ready / failed: the job's result. failed shows the original and a
 *   "Try again"; the nightly retry requeues failed rows under 3 attempts.
 *   Only failed rows are retried: a pending one is queued or running
 *   already, and requeueing it would throw away a running job's result
 *   and run the model again.
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
  'unwanted',
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
  /**
   * The queue worker (CutoutQueue, one per start) holding the running
   * job's lease; null when none runs. When the lease was taken
   * (cutout_started_at) is the database's clock, written with it by
   * applyCutoutEvent.
   */
  worker: string | null;
}

export type CutoutEvent =
  /** A photo was stored: ask for its cutout. */
  | { type: 'request' }
  /** "Try again" or the nightly retry. */
  | { type: 'retry' }
  /** The queue picked the row up: `worker` takes its lease. */
  | { type: 'start'; worker: string }
  /**
   * `worker`'s job ended without a result that clears its lease (its
   * shutdown, a result refused as stale): the row is free at once.
   */
  | { type: 'release'; worker: string }
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
       * stale: a job result for another photo version than the row's, or
       * a release from a worker whose lease lapsed and was taken since.
       */
      reason: 'not-allowed' | 'stale';
    };

/** The statuses each event applies to; any other refuses it (not-allowed). */
const ACCEPTED_FROM: Record<CutoutEventType, readonly CutoutStatus[]> = {
  request: ['none'],
  retry: ['failed'],
  start: ['pending'],
  release: ['pending'],
  succeed: ['pending'],
  fail: ['pending'],
  edit: CUTOUT_STATUSES.filter((status) => status !== 'unwanted'),
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
  if (event.type === 'release' && state.worker !== event.worker) {
    return { ok: false, reason: 'stale' };
  }
  return {
    ok: true,
    state: nextState(state, event),
    queued: event.type === 'request' || event.type === 'retry',
  };
}

// The accepted event's effect on the row. Only start sets a lease; every
// other event leaves the row without one (applyCutoutEvent relies on it).
function nextState(state: CutoutState, event: CutoutEvent): CutoutState {
  const noJob = { jobVersion: null, worker: null };
  switch (event.type) {
    case 'request':
    case 'retry':
      return { ...state, ...noJob, status: 'pending' };
    case 'start':
      // Also over a lapsed lease: the claim (claimNextCutout) only offers a
      // row whose lease is free or expired.
      return {
        ...state,
        attempts: state.attempts + 1,
        jobVersion: state.version,
        worker: event.worker,
      };
    case 'release':
      // Its attempt stays counted; the row keeps its place in the queue.
      return { ...state, ...noJob };
    case 'succeed':
      // New cutout bytes under the same name: a new version URL.
      return {
        ...state,
        ...noJob,
        status: 'ready',
        version: state.version + 1,
      };
    case 'fail':
      return { ...state, ...noJob, status: 'failed' };
    case 'edit':
      return {
        ...state,
        ...noJob,
        status: 'edited',
        version: state.version + 1,
      };
  }
}

/**
 * The cutout columns of a photo row about to be inserted: `status` is what
 * the new row starts as (none, or the result of `request`; a copied photo
 * takes its source's status, and a pending copy is queued in its own
 * right; a selfie is unwanted).
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

/**
 * Whether a photo's variants show the garment cut out (drawn contained on
 * the plinth, never cropped) rather than the photo as taken (drawn to cover
 * its frame): the wardrobe grid's tiles and the capsule strips. `none` is a
 * photo from before 2026-09-26, whose cutout the browser made; one without
 * is drawn whole, letterboxed on the plinth, which still crops nothing.
 */
export function showsCutout(status: CutoutStatus): boolean {
  return status === 'ready' || status === 'edited' || status === 'none';
}
