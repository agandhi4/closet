import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureLogs } from '../../test/support/log-capture';
import { nextRunAt, scheduleNightly } from './nightly';

// Every instant is explicit UTC and every zone is named, so these hold
// whatever zone the test process runs in. Fake timers throughout: every
// wait is advanced explicitly, so the stop specs never depend on the
// machine's speed (run 30 times in a row to prove it, as minutely.spec.ts).
const NY = 'America/New_York';
const HOUR = 60 * 60 * 1000;

describe('nextRunAt', () => {
  it.each([
    // An ordinary winter day: 03:00 EST is 08:00 UTC.
    ['2026-01-15T07:59:00Z', '2026-01-15T08:00:00.000Z'],
    ['2026-01-15T08:00:00Z', '2026-01-16T08:00:00.000Z'],
    // Late evening in New York is already tomorrow in UTC.
    ['2026-01-16T02:00:00Z', '2026-01-16T08:00:00.000Z'],
    // Summer: 03:00 EDT is 07:00 UTC.
    ['2026-07-01T12:00:00Z', '2026-07-02T07:00:00.000Z'],
    // Spring forward (8 March 2026, 02:00 -> 03:00): 03:00 EDT exists.
    ['2026-03-08T05:00:00Z', '2026-03-08T07:00:00.000Z'],
    // Fall back (1 November 2026, 02:00 -> 01:00): 03:00 EST.
    ['2026-11-01T04:00:00Z', '2026-11-01T08:00:00.000Z'],
  ])('from %s is %s', (now, expected) => {
    expect(nextRunAt(new Date(now), NY, 3).toISOString()).toBe(expected);
  });

  it('reads the hour in the given zone, not the process zone', () => {
    expect(
      nextRunAt(new Date('2026-07-01T12:00:00Z'), 'Europe/Berlin', 3),
    ).toEqual(new Date('2026-07-02T01:00:00.000Z'));
    expect(nextRunAt(new Date('2026-07-01T12:00:00Z'), 'UTC', 3)).toEqual(
      new Date('2026-07-02T03:00:00.000Z'),
    );
  });
});

describe('scheduleNightly', () => {
  const { logger, logs } = captureLogs();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
    logs.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs at 03:00 in the zone every day, and a failure does not stop it', async () => {
    const run = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('storage unreachable'))
      .mockResolvedValue(undefined);
    const job = scheduleNightly({
      name: 'Test job',
      hour: 3,
      timeZone: NY,
      run,
      logger,
    });

    // Due at 2026-01-16T08:00Z, twenty hours on.
    await vi.advanceTimersByTimeAsync(20 * 60 * 60 * 1000 - 1);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    const [failure] = logs.records.filter((record) => record.level === 'error');
    expect(failure.msg).toBe('Test job failed');
    expect(failure.err?.stack).toContain('storage unreachable');

    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(run).toHaveBeenCalledTimes(2);
    await job.stop();
  });

  it('never runs once stopped', async () => {
    const run = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const job = scheduleNightly({
      name: 'Test job',
      hour: 3,
      timeZone: NY,
      run,
      logger,
    });
    await job.stop();
    await vi.advanceTimersByTimeAsync(3 * 24 * HOUR);
    expect(run).not.toHaveBeenCalled();
  });

  it('stop() waits for a run in flight, then runs nothing more', async () => {
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const job = scheduleNightly({
      name: 'Test job',
      hour: 3,
      timeZone: NY,
      run,
      logger,
    });
    await vi.advanceTimersByTimeAsync(20 * HOUR);
    expect(run).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopping = job.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(stopped).toBe(true);
    expect(logs.messages('warn')).toEqual([]);
    // The run's end schedules nothing once stopped.
    await vi.advanceTimersByTimeAsync(3 * 24 * HOUR);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stop() waits for a run that fails, and logs the failure', async () => {
    let fail!: (error: Error) => void;
    const run = vi.fn(
      () => new Promise<void>((_resolve, reject) => (fail = reject)),
    );
    const job = scheduleNightly({
      name: 'Test job',
      hour: 3,
      timeZone: NY,
      run,
      logger,
    });
    await vi.advanceTimersByTimeAsync(20 * HOUR);
    const stopping = job.stop();
    fail(new Error('pool ended'));
    await expect(stopping).resolves.toBeUndefined();
    expect(logs.messages('error')).toEqual(['Test job failed']);
    await vi.advanceTimersByTimeAsync(3 * 24 * HOUR);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stop() gives up on a run that never ends after 15 s, with a warning', async () => {
    const run = vi.fn(() => new Promise<void>(() => {}));
    const job = scheduleNightly({
      name: 'Stuck job',
      hour: 3,
      timeZone: NY,
      run,
      logger,
    });
    await vi.advanceTimersByTimeAsync(20 * HOUR);
    let stopped = false;
    const stopping = job.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(14_999);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(logs.messages('warn')).toEqual([
      'Stuck job still running after 15000 ms; stopped',
    ]);
    await vi.advanceTimersByTimeAsync(3 * 24 * HOUR);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
