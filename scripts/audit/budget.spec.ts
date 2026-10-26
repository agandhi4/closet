import { describe, expect, it } from 'vitest';
import {
  type AuditLimit,
  auditLimit,
  Budgets,
  SAFETY_MARGIN_MS,
} from './budget';

const MINUTE = 60_000;

/** A tracker on a fake clock that a sleep advances; its waits, in order. */
function tracker() {
  let now = 0;
  const waits: { key: string; ms: number }[] = [];
  const budgets = new Budgets({
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    onWait: (limit, ms) => waits.push({ key: limit.key, ms }),
  });
  return {
    budgets,
    waits,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    /** One call in each of `limits`, taking `ms` of the clock. */
    call: (limits: readonly AuditLimit[], ms = 0) =>
      budgets.spend(limits, () => {
        now += ms;
        return Promise.resolve(now);
      }),
  };
}

describe('Budgets', () => {
  const shared = auditLimit('link import (Theo)', {
    max: 3,
    timeWindow: MINUTE,
  });

  it('reads max and the window off the app’s limit', () => {
    expect(auditLimit('k', { max: 10, timeWindow: MINUTE })).toEqual({
      key: 'k',
      max: 10,
      windowMs: MINUTE,
    });
  });

  it('runs a step with no limits at once, and up to max calls without waiting', async () => {
    const t = tracker();
    await t.call([]);
    for (let i = 0; i < shared.max; i++) await t.call([shared], 100);
    expect(t.waits).toEqual([]);
    expect(t.now()).toBe(300);
  });

  it('waits past the window of the call max back, counted when it answered', async () => {
    const t = tracker();
    // Two steps of one budget: the second's first call is the fourth.
    for (let i = 0; i < shared.max; i++) await t.call([shared], 100);
    await t.call([shared]);
    // The first call answered at 100: room again at 100 + window + margin.
    expect(t.waits).toEqual([
      { key: shared.key, ms: 100 + MINUTE + SAFETY_MARGIN_MS - 300 },
    ]);
    expect(t.now()).toBe(100 + MINUTE + SAFETY_MARGIN_MS);
    expect(t.budgets.waitedMs).toBe(t.waits[0].ms);
  });

  it('keeps budgets with different keys apart', async () => {
    const t = tracker();
    const other = { ...shared, key: 'order item add (Theo)' };
    for (let i = 0; i < shared.max; i++) await t.call([shared]);
    for (let i = 0; i < other.max; i++) await t.call([other]);
    expect(t.waits).toEqual([]);
  });

  it('waits for the fullest of a call’s budgets, then counts it in each', async () => {
    const t = tracker();
    const perToken = auditLimit('mcp (token 0)', {
      max: 5,
      timeWindow: MINUTE,
    });
    await t.call([shared]);
    t.advance(10_000);
    await t.call([shared]);
    await t.call([shared]);
    await t.call([perToken, shared]);
    expect(t.waits).toEqual([
      { key: shared.key, ms: MINUTE + SAFETY_MARGIN_MS - 10_000 },
    ]);
    // The per-token budget counted that call too: four more fill it.
    for (let i = 0; i < 4; i++) await t.call([perToken]);
    await t.call([perToken]);
    expect(t.waits).toHaveLength(2);
    expect(t.waits[1].key).toBe(perToken.key);
  });

  it('counts a call that threw, since the app may have counted it', async () => {
    const t = tracker();
    for (let i = 0; i < shared.max; i++) {
      await expect(
        t.budgets.spend([shared], () => Promise.reject(new Error('429'))),
      ).rejects.toThrow('429');
    }
    await t.call([shared]);
    expect(t.waits).toHaveLength(1);
  });

  it('forgets calls once they leave the window', async () => {
    const t = tracker();
    for (let i = 0; i < shared.max; i++) await t.call([shared]);
    t.advance(MINUTE + SAFETY_MARGIN_MS);
    for (let i = 0; i < shared.max; i++) await t.call([shared]);
    expect(t.waits).toEqual([]);
  });

  it('refuses one key declared with two different limits', async () => {
    const t = tracker();
    await t.call([shared]);
    await expect(t.call([{ ...shared, max: shared.max + 1 }])).rejects.toThrow(
      'declared as 3 per 60000 ms and as 4 per 60000 ms',
    );
  });
});
