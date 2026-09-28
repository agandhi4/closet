import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureLogs } from '../../test/support/log-capture';
import { scheduleMinutely, untilNextMinute } from './minutely';

/**
 * The minute timer the push reminders run on (server.ts). Fake timers
 * throughout: every wait is advanced explicitly, so the spec never depends
 * on the machine's speed (it is run 30 times in a row, some under CPU
 * load, to prove it; CLAUDE.md, Web Push).
 */

const at = (iso: string) => new Date(iso);
const MINUTE = 60_000;

describe('untilNextMinute', () => {
  it.each([
    // A second past the next minute's start.
    ['2026-01-15T07:29:30.000Z', 31_000],
    ['2026-01-15T07:29:59.999Z', 1_001],
    // Exactly on the minute: this minute's second is still ahead.
    ['2026-01-15T07:30:00.000Z', 1_000],
    ['2026-01-15T07:30:00.500Z', 500],
    // At or past this minute's second: the next minute's.
    ['2026-01-15T07:30:01.000Z', 60_000],
    ['2026-01-15T07:30:01.001Z', 59_999],
  ])('from %s is %i ms', (now, expected) => {
    expect(untilNextMinute(at(now))).toBe(expected);
  });

  it.each([
    // Every 5 minutes (the order mail's poll): a second past :30, :35 ...
    ['2026-01-15T07:29:30.000Z', 31_000],
    ['2026-01-15T07:30:00.500Z', 500],
    ['2026-01-15T07:30:01.000Z', 5 * MINUTE],
    ['2026-01-15T07:33:00.000Z', 2 * MINUTE + 1_000],
  ])('every 5 minutes, from %s is %i ms', (now, expected) => {
    expect(untilNextMinute(at(now), 5)).toBe(expected);
  });
});

describe('scheduleMinutely', () => {
  const { logger, logs } = captureLogs();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(at('2026-01-15T07:29:30.000Z'));
    logs.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a second past every minute, with the instant it runs for', async () => {
    const run = vi.fn<(now: Date) => Promise<void>>().mockResolvedValue();
    const job = scheduleMinutely({ name: 'Test job', run, logger });

    await vi.advanceTimersByTimeAsync(30_999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toEqual(at('2026-01-15T07:30:01.000Z'));

    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(run.mock.calls.map(([now]) => now.toISOString())).toEqual([
      '2026-01-15T07:30:01.000Z',
      '2026-01-15T07:31:01.000Z',
      '2026-01-15T07:32:01.000Z',
    ]);
    await job.stop();
  });

  it('never overlaps a slow run, and skips the minutes it overran', async () => {
    let active = 0;
    let most = 0;
    const run = vi.fn(async () => {
      active += 1;
      most = Math.max(most, active);
      // 90 s: past the next minute's start.
      await new Promise((resolve) => setTimeout(resolve, 90_000));
      active -= 1;
    });
    const job = scheduleMinutely({ name: 'Slow job', run, logger });

    await vi.advanceTimersByTimeAsync(31_000 + 4 * MINUTE);
    expect(most).toBe(1);
    // 07:30:01 ends 07:31:31, so the next is 07:32:01, then 07:34:01.
    expect(run.mock.calls.length).toBe(3);
    // The third is still running: stop() waits for it.
    const stopping = job.stop();
    await vi.advanceTimersByTimeAsync(90_000);
    await stopping;
    expect(run.mock.calls.length).toBe(3);
  });

  it('keeps running after a failed minute, and logs it', async () => {
    const run = vi
      .fn<(now: Date) => Promise<void>>()
      .mockRejectedValueOnce(new Error('database unreachable'))
      .mockResolvedValue();
    const job = scheduleMinutely({ name: 'Test job', run, logger });

    await vi.advanceTimersByTimeAsync(31_000 + MINUTE);
    expect(run).toHaveBeenCalledTimes(2);
    const [failure] = logs.records.filter((record) => record.level === 'error');
    expect(failure.msg).toBe('Test job failed');
    expect(failure.err?.stack).toContain('database unreachable');
    await job.stop();
  });

  it('never runs once stopped', async () => {
    const run = vi.fn<(now: Date) => Promise<void>>().mockResolvedValue();
    const job = scheduleMinutely({ name: 'Test job', run, logger });
    await job.stop();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(run).not.toHaveBeenCalled();
  });

  it('stop() waits for a run in flight, then runs nothing more', async () => {
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const job = scheduleMinutely({ name: 'Test job', run, logger });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(run).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopping = job.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stop() gives up on a run that never ends, with a warning', async () => {
    const run = vi.fn(() => new Promise<void>(() => {}));
    const job = scheduleMinutely({ name: 'Stuck job', run, logger });
    await vi.advanceTimersByTimeAsync(31_000);
    const stopping = job.stop();
    await vi.advanceTimersByTimeAsync(15_000);
    await stopping;
    expect(logs.messages('warn')).toEqual([
      'Stuck job still running after 15000 ms; stopped',
    ]);
  });
});
