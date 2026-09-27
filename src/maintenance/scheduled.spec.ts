import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureLogs } from '../../test/support/log-capture';
import { scheduleMinutely } from './minutely';
import { scheduleNightly } from './nightly';
import { type ScheduledJob, stopBeforeClose } from './scheduled';

/**
 * The shutdown contract of server.ts's timers (#78): every job is stopped
 * at preClose and a run in flight ends before any onClose hook, where
 * createApp ends the pool. A real Fastify instance, and a real onClose
 * hook standing in for the pool's end. Only the timers the jobs use are
 * faked (Fastify's own lifecycle keeps setImmediate), and every wait is
 * advanced explicitly: run 30 times in a row to prove it does not depend
 * on the machine's speed.
 */

const NY = 'America/New_York';
const DAY = 24 * 60 * 60 * 1000;

describe('stopBeforeClose', () => {
  const { logger, logs } = captureLogs();
  let events: string[];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    // A second before 03:00 in New York (08:00 UTC).
    vi.setSystemTime(new Date('2026-01-16T07:59:59Z'));
    logs.clear();
    events = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const nightly = (name: string, run: () => Promise<void>) =>
    scheduleNightly({ name, hour: 3, timeZone: NY, run, logger });

  /** An app whose onClose records the pool's end, as createApp's does. */
  const appStopping = async (
    jobs: ScheduledJob[],
  ): Promise<FastifyInstance> => {
    // No plugin timeout: avvio's runs on the faked setTimeout, and a close
    // held for the bound would trip it.
    const app = Fastify({ pluginTimeout: 0 });
    app.addHook('onClose', (_instance, done) => {
      events.push('pool ended');
      done();
    });
    stopBeforeClose(app, jobs, logger);
    await app.ready();
    return app;
  };

  /** A run that stays in flight until finish() is called. */
  const heldRun = (name: string) => {
    let finish!: () => void;
    const run = vi.fn(async () => {
      await new Promise<void>((resolve) => (finish = resolve));
      events.push(`${name} ended`);
    });
    return { run, finish: () => finish() };
  };

  it('ends a nightly run in flight before the pool, and starts none after', async () => {
    const reconcile = heldRun('reconciliation');
    const app = await appStopping([nightly('Reconciliation', reconcile.run)]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reconcile.run).toHaveBeenCalledTimes(1);

    const closing = app.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events).toEqual([]);
    reconcile.finish();
    await closing;
    expect(events).toEqual(['reconciliation ended', 'pool ended']);
    expect(logs.messages('info')).toContain(
      'Stopped 1 scheduled jobs in 10000 ms',
    );

    await vi.advanceTimersByTimeAsync(3 * DAY);
    expect(reconcile.run).toHaveBeenCalledTimes(1);
  });

  it('waits for every job, nightly and minutely, before the pool ends', async () => {
    const reconcile = heldRun('reconciliation');
    const prune = heldRun('prune');
    const reminders = heldRun('reminders');
    const app = await appStopping([
      nightly('Reconciliation', reconcile.run),
      nightly('Prune', prune.run),
      scheduleMinutely({ name: 'Reminders', run: reminders.run, logger }),
    ]);
    // 03:00:00 starts both nightly jobs, 03:00:01 the minute's.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reconcile.run).toHaveBeenCalledTimes(1);
    expect(prune.run).toHaveBeenCalledTimes(1);
    expect(reminders.run).toHaveBeenCalledTimes(1);

    const closing = app.close();
    prune.finish();
    reminders.finish();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events).toEqual(['prune ended', 'reminders ended']);
    reconcile.finish();
    await closing;
    expect(events).toEqual([
      'prune ended',
      'reminders ended',
      'reconciliation ended',
      'pool ended',
    ]);

    await vi.advanceTimersByTimeAsync(3 * DAY);
    expect(reconcile.run).toHaveBeenCalledTimes(1);
    expect(prune.run).toHaveBeenCalledTimes(1);
    expect(reminders.run).toHaveBeenCalledTimes(1);
  });

  it('abandons hung runs after one bound, together, with a warning each, and still ends the pool', async () => {
    const hung = () => new Promise<void>(() => {});
    const app = await appStopping([
      nightly('Reconciliation', vi.fn(hung)),
      nightly('Cutout retry', vi.fn(hung)),
    ]);
    await vi.advanceTimersByTimeAsync(1_000);

    let closed = false;
    const closing = app.close().then(() => (closed = true));
    await vi.advanceTimersByTimeAsync(14_999);
    expect(closed).toBe(false);
    expect(events).toEqual([]);
    // The two bounds run side by side: 15 s in all, not 30.
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(events).toEqual(['pool ended']);
    expect(logs.messages('warn').sort()).toEqual([
      'Cutout retry still running after 15000 ms; stopped',
      'Reconciliation still running after 15000 ms; stopped',
    ]);
  });

  it('closes at once when no run is in flight', async () => {
    const run = vi.fn(() => Promise.resolve());
    const app = await appStopping([nightly('Reconciliation', run)]);
    await app.close();
    expect(events).toEqual(['pool ended']);
    await vi.advanceTimersByTimeAsync(3 * DAY);
    expect(run).not.toHaveBeenCalled();
  });
});
