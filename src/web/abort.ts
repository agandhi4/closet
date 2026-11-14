/**
 * A scheduled run's AbortSignal (ScheduledJob, src/maintenance/scheduled.ts)
 * as the work under it sees it: the morning reminder's compose, the re-plan
 * it runs and the forecast read they make. Work checks the signal at its
 * step boundaries (`signal?.throwIfAborted()`), so an abort ends it at the
 * next one, a transaction's work throwing before its commit; the caller
 * awaits it to the end and never abandons it (#920).
 */

/** Whether `error` is `signal`'s abort, as throwIfAborted or waitUnlessAborted threw it. */
export function abortedBy(
  signal: AbortSignal | undefined,
  error: unknown,
): boolean {
  return signal?.aborted === true && error === signal.reason;
}

/**
 * `shared`'s outcome, or `signal`'s reason the moment it aborts. Only for
 * a promise whose work someone else owns and awaits to its end (the
 * forecast cache's refresh, which the app's close awaits through
 * settled()): this caller stops waiting, the work does not stop.
 */
export function waitUnlessAborted<T>(
  shared: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return shared;
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    void shared.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}
