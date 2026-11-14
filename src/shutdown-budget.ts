/**
 * How long a shutdown may take, in one place. `docker stop` sends SIGTERM
 * and SIGKILLs after 10 s (Compose's default `stop_grace_period`, which
 * production does not raise), so everything below must finish well inside
 * that: a kill before the cutout queue releases its lease leaves the photo
 * leased until CUTOUT_LEASE_MS lapses, and one before the error tracker
 * flushes loses its last events.
 *
 * The phases run in sequence (app.close()): the timers' runs in flight at
 * preClose (src/maintenance/scheduled.ts), then at onClose the cutout queue,
 * the weather refreshes and the HEIC thread together (src/app.ts), then the error tracker
 * (src/metrics/error-tracker.ts). The request drain, the pool's end and the
 * exit are not bounded here: they are what the margin under
 * SHUTDOWN_BUDGET_MS and Docker's 10 s is for.
 * shutdown-budget.spec.ts asserts the sum fits; raising a bound fails it.
 */

/** What `docker stop` waits for before SIGKILL, with no stop_grace_period set. */
export const DOCKER_STOP_GRACE_MS = 10_000;

/** The bounded phases, summed, must stay within this. */
export const SHUTDOWN_BUDGET_MS = 8_000;

/** preClose: waiting for each timer's run in flight (a push send's socket timeout is 10 s a device: cut off, not waited out). */
export const JOBS_STOP_MS = 2_000;

/**
 * The last part of JOBS_STOP_MS: a run still going when the rest has passed
 * is aborted (its AbortSignal), and has this long to put its work back
 * (the reminders give back the claims they never sent on) before stop()
 * gives up on it. The run itself is awaited for JOBS_STOP_MS minus this.
 */
export const JOBS_ABORT_GRACE_MS = 500;

/** The cutout listener's orderly close, before its socket is destroyed. */
export const CUTOUT_LISTENER_CLOSE_MS = 1_500;

/**
 * The cutout runner closing and the job loop ending: a job cut short
 * releases its lease inside this, so the next server runs it at once.
 */
export const CUTOUT_LOOP_STOP_MS = 2_500;

/** The whole cutout queue's stop; the weather refreshes settle in parallel within it. */
export const CUTOUT_STOP_MS = CUTOUT_LISTENER_CLOSE_MS + CUTOUT_LOOP_STOP_MS;

/**
 * Terminating the HEIC decoder's thread (Photos.close), in parallel with
 * the cutout queue's stop and inside it: terminate() interrupts a decode,
 * so this is only the thread's teardown.
 */
export const HEIC_DECODER_STOP_MS = 500;

/** onClose's last step: the error tracker's flush. */
export const ERROR_TRACKER_CLOSE_MS = 1_000;

/** The bounded phases, in sequence. */
export const SHUTDOWN_BOUNDED_MS =
  JOBS_STOP_MS + CUTOUT_STOP_MS + ERROR_TRACKER_CLOSE_MS;
