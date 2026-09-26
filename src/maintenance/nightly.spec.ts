import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebLogger } from '../web/logger';
import { nextRunAt, scheduleNightly } from './nightly';

// Every instant is explicit UTC and every zone is named, so these hold
// whatever zone the test process runs in.
const NY = 'America/New_York';

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
  const error = vi.fn();
  const logger: WebLogger = {
    debug: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
    error,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
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
    expect(error).toHaveBeenCalledWith(
      'Test job failed',
      expect.stringContaining('storage unreachable'),
    );

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(run).toHaveBeenCalledTimes(2);
    job.stop();
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
    job.stop();
    await vi.advanceTimersByTimeAsync(3 * 24 * 60 * 60 * 1000);
    expect(run).not.toHaveBeenCalled();
  });
});
