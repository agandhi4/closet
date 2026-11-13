import { describe, expect, it } from 'vitest';
import {
  collapsed,
  dayRefusal,
  goesThroughOutbox,
  isChecklist,
  isReplayRequest,
  QUEUEABLE_ROUTES,
  type QueueableKind,
  queueableKindOf,
  queuedTarget,
  REPLAY_WINDOW_DAYS,
  replayVerdict,
  retryDelayMs,
  takesDay,
} from './offline-writes';

describe('dayRefusal', () => {
  const today = '2026-03-02';

  it('accepts today and back to the window’s first day, across a month end', () => {
    expect(REPLAY_WINDOW_DAYS).toBe(7);
    for (const day of ['2026-03-02', '2026-03-01', '2026-02-23']) {
      expect(dayRefusal(day, today), day).toBeUndefined();
    }
  });

  it('refuses a day before the window as too old and one after today as future', () => {
    expect(dayRefusal('2026-02-22', today)).toBe('too-old');
    expect(dayRefusal('2026-03-03', today)).toBe('future');
  });
});

describe('queuedTarget', () => {
  it('keys each kind so that only the same intent collapses', () => {
    expect([
      queuedTarget('wear', 41, '2026-11-12'),
      queuedTarget('wash', 41),
      queuedTarget('entry', 88),
      queuedTarget('packed', 7, 41),
      queuedTarget('item', 7, 3),
    ]).toEqual([
      { key: 'wear:41:2026-11-12', path: '/wardrobe/41/wear' },
      { key: 'wash:41', path: '/wardrobe/41/washed' },
      { key: 'entry:88', path: '/calendar/88/worn' },
      { key: 'packed:7:41', path: '/trips/7/packed' },
      { key: 'item:7:3', path: '/trips/7/items/packed' },
    ]);
    // A wear on another day, or another trip's tick of the same garment,
    // is another record.
    expect(queuedTarget('wear', 41, '2026-11-11').key).not.toBe(
      queuedTarget('wear', 41, '2026-11-12').key,
    );
    expect(queuedTarget('packed', 8, 41).key).not.toBe(
      queuedTarget('packed', 7, 41).key,
    );
  });

  it('builds the paths the allowlist takes back, kind for kind', () => {
    for (const kind of Object.keys(QUEUEABLE_ROUTES) as QueueableKind[]) {
      expect(queueableKindOf(queuedTarget(kind, 12, 3).path), kind).toBe(kind);
    }
  });
});

describe('queueableKindOf', () => {
  it('replays only the queueable routes, by their whole path', () => {
    for (const path of [
      '/wardrobe/41/away',
      '/wardrobe/41/wear/x',
      '/x/wardrobe/41/wear',
      '/wardrobe/0/wear',
      '/wardrobe/abc/washed',
      '/wardrobe/41/wear?worn=1',
      '/trips/7/items/3/delete',
      'https://elsewhere.example/wardrobe/41/wear',
      '/auth/logout',
    ]) {
      expect(queueableKindOf(path), path).toBeUndefined();
    }
  });
});

describe('the kinds', () => {
  it('dates the wear and the wash with the tap’s day, and ticks per item', () => {
    const kinds = Object.keys(QUEUEABLE_ROUTES) as QueueableKind[];
    expect(kinds.filter(takesDay)).toEqual(['wear', 'wash']);
    expect(kinds.filter(isChecklist)).toEqual(['packed', 'item']);
  });
});

describe('isReplayRequest', () => {
  it('reads the replay header from Node’s lower-cased headers', () => {
    expect(isReplayRequest({ 'x-closet-queued': '12' })).toBe(true);
    expect(isReplayRequest({ 'sec-fetch-mode': 'cors' })).toBe(false);
  });
});

describe('goesThroughOutbox', () => {
  const pending = new Set(['wear:41:2026-11-12']);

  it('queues every tap offline, and online any tap whose key waits', () => {
    expect(goesThroughOutbox(true, ['wash:41'], new Set())).toBe(true);
    expect(goesThroughOutbox(false, ['wear:41:2026-11-12'], pending)).toBe(
      true,
    );
    // The laundry's batch: one waiting row sends all of them through it.
    expect(
      goesThroughOutbox(false, ['wash:7', 'wear:41:2026-11-12'], pending),
    ).toBe(true);
  });

  it('sends a tap straight on online when none of its keys waits', () => {
    expect(goesThroughOutbox(false, ['wear:41:2026-11-11'], pending)).toBe(
      false,
    );
    expect(goesThroughOutbox(false, [], pending)).toBe(false);
  });
});

describe('collapsed', () => {
  const record = (id: string, key: string, account = '1') => ({
    id,
    key,
    account,
  });

  it('puts the newest intent in place of its account’s record of the key', () => {
    const old = [record('a', 'wash:41'), record('b', 'wear:41:2026-11-12')];
    expect(collapsed(old, [record('c', 'wear:41:2026-11-12')])).toEqual([
      record('a', 'wash:41'),
      record('c', 'wear:41:2026-11-12'),
    ]);
  });

  it('keeps another account’s record of the same key', () => {
    expect(
      collapsed([record('a', 'wash:41', '2')], [record('b', 'wash:41')]),
    ).toEqual([record('a', 'wash:41', '2'), record('b', 'wash:41')]);
  });
});

describe('replayVerdict', () => {
  it.each([
    [204, 'changed', { verdict: 'saved', changed: true }],
    [204, 'unchanged', { verdict: 'saved', changed: false }],
    [401, null, { verdict: 'signed-out' }],
    // The login redirect, opaque under `redirect: 'manual'`: kept for the
    // sign-in, never failed.
    [0, null, { verdict: 'signed-out' }],
    [404, null, { verdict: 'failed', reason: 'gone' }],
    [409, 'too-old', { verdict: 'failed', reason: 'too-old' }],
    [409, 'future', { verdict: 'failed', reason: 'future' }],
    [409, 'account', { verdict: 'failed', reason: 'account' }],
    // A wishlist item: a 409 with no reason of the contract.
    [409, null, { verdict: 'failed', reason: 'refused' }],
    [409, 'changed', { verdict: 'failed', reason: 'refused' }],
    [400, null, { verdict: 'failed', reason: 'refused' }],
    [403, null, { verdict: 'failed', reason: 'refused' }],
    // A page: an answer that is not the replay contract's is never taken
    // for saved.
    [200, null, { verdict: 'failed', reason: 'refused' }],
    [500, null, { verdict: 'retry' }],
    [503, null, { verdict: 'retry' }],
    [408, null, { verdict: 'retry' }],
    [429, null, { verdict: 'retry' }],
  ] as const)('reads %i (%s)', (status, outcome, verdict) => {
    expect(replayVerdict(status, outcome)).toEqual(verdict);
  });
});

describe('retryDelayMs', () => {
  it('waits 5 s, doubling, at most 5 minutes', () => {
    expect([0, 1, 2, 3, 6, 7, 30].map(retryDelayMs)).toEqual([
      5_000, 5_000, 10_000, 20_000, 160_000, 300_000, 300_000,
    ]);
  });
});
