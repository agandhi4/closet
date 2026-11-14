import type { JobName } from './metrics';

/**
 * A run that finished everyone it could and still left someone out: a
 * person's reminder or re-plan that failed, a reconciliation the guard
 * refused or that found photo rows without their bytes. Thrown by the
 * job's wrapper after the run, so `metrics.timeJob`, the one choke point,
 * records `failure` and captures once (#687); the scheduler logs it.
 *
 * The message names the job and counts, never a person or a path (it
 * reaches the error tracker). Each cause is already logged with its ids
 * where it happened.
 *
 * `reported`: every cause was captured by an earlier run, so this one is
 * still `failure` but captures nothing (the order mail's email failing on
 * each retry: one event per email, #693).
 */
export class PartialFailure extends Error {
  constructor(
    readonly job: JobName,
    readonly counts: Readonly<Record<string, number>>,
    readonly reported = false,
  ) {
    super(
      `${job} ended partially: ${Object.entries(counts)
        .map(([what, n]) => `${n} ${what}`)
        .join(', ')}`,
    );
    this.name = 'PartialFailure';
  }
}

/**
 * Throws PartialFailure when any count is above zero, keeping only the
 * nonzero ones in the message. Returns `run` otherwise, so a wrapper reads
 * `return endWhole('reminders', { failed: run.failed }, run)`.
 */
export function endWhole<T>(
  job: JobName,
  counts: Readonly<Record<string, number>>,
  run: T,
  { reported = false }: { reported?: boolean } = {},
): T {
  const nonzero = Object.entries(counts).filter(([, n]) => n > 0);
  if (nonzero.length > 0)
    throw new PartialFailure(job, Object.fromEntries(nonzero), reported);
  return run;
}

/**
 * A run that shutdown cut off after it put its work back (the reminders
 * give back their claims): `metrics.timeJob` records `interrupted`, which
 * alerts no one and captures nothing, and the scheduler logs it at info.
 * Never a failure: the next server finds the work and does it.
 */
export class JobInterrupted extends Error {
  constructor(readonly job: JobName) {
    super(`${job} was interrupted by shutdown`);
    this.name = 'JobInterrupted';
  }
}
