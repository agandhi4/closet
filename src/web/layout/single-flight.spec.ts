import { describe, expect, it } from 'vitest';
// connectivity.js's probe runs in the browser (public/js/ is served as it is,
// not built); its scheduling is this pure helper, tested here.
import { singleFlight } from '../../../public/js/single-flight.js';

/** A task whose runs settle when the test says, recording each run's argument. */
function controlled() {
  const runs: string[] = [];
  const settle: Array<(ok: boolean) => void> = [];
  const task = (arg: string) => {
    runs.push(arg);
    return new Promise<string>((resolve, reject) => {
      settle.push((ok) => (ok ? resolve(arg) : reject(new Error(arg))));
    });
  };
  return { runs, settle, task };
}

describe('singleFlight', () => {
  // The #436 regression: joining the run in flight answered an `offline`
  // event with the page-load probe's 200.
  it('answers calls made mid-flight with one fresh run, not the stale one', async () => {
    const { runs, settle, task } = controlled();
    const run = singleFlight(task);
    const first = run('load');
    const second = run('offline-event');
    const third = run('htmx:sendError');
    expect(second).toBe(third);
    expect(runs).toEqual(['load']);

    settle[0](true);
    await expect(first).resolves.toBe('load');
    expect(runs).toEqual(['load', 'offline-event']);
    settle[1](true);
    await expect(second).resolves.toBe('offline-event');

    // Idle again: the next call starts at once, with no follow-up.
    const fourth = run('timer');
    expect(runs).toEqual(['load', 'offline-event', 'timer']);
    settle[2](true);
    await expect(fourth).resolves.toBe('timer');
    expect(runs).toHaveLength(3);
  });

  it('still runs the follow-up when the run in flight rejects', async () => {
    const { runs, settle, task } = controlled();
    const run = singleFlight(task);
    const first = run('a');
    const second = run('b');
    settle[0](false);
    await expect(first).rejects.toThrow('a');
    expect(runs).toEqual(['a', 'b']);
    settle[1](true);
    await expect(second).resolves.toBe('b');
  });
});
