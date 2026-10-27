/**
 * Runs an async task one at a time, without dropping a call that arrives
 * mid-flight: such a call gets one more run after the current one settles
 * (every call in that window shares it). A plain "join the run in flight"
 * answers newer evidence with a result taken before it existed, which is how
 * an `offline` event during the page-load heartbeat was lost for 30 s (#436).
 *
 * Used by connectivity.js's probe; unit-tested in
 * src/web/layout/single-flight.spec.ts.
 *
 * @template {unknown[]} A
 * @template T
 * @param {(...args: A) => Promise<T>} task
 * @returns {(...args: A) => Promise<T>}
 */
export function singleFlight(task) {
  let current = null;
  let next = null;
  const start = (args) => {
    current = task(...args).finally(() => {
      current = null;
    });
    return current;
  };
  return (...args) => {
    if (!current) return start(args);
    // `current` is the promise after start()'s finally, so it is null by
    // the time rerun runs; a rejected run still gets its follow-up.
    const rerun = () => {
      next = null;
      return start(args);
    };
    next ??= current.then(rerun, rerun);
    return next;
  };
}
