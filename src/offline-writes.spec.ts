import { describe, expect, it } from 'vitest';
import {
  dayRefusal,
  enqueue,
  goesThroughOutbox,
  isChecklist,
  isReplayRequest,
  OUTBOX_MAX_PENDING,
  type OutboxStore,
  QUEUEABLE_ROUTES,
  type QueueableKind,
  queueableKindOf,
  queuedTarget,
  queuedWritesGoneAtClaim,
  REPLAY_WINDOW_DAYS,
  replayVerdict,
  retryDelayMs,
  routesThroughOutbox,
  sharedUntilRejected,
  showsQueuedWrite,
  type StoredRecord,
  syncedWritePaths,
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

describe('the queue over its store', () => {
  interface Row extends StoredRecord {
    id: string;
  }
  const row = (
    id: string,
    key: string,
    { account = '1', state = 'pending' }: Partial<StoredRecord> = {},
  ): Row => ({ id, key, account, state });

  /** An in-memory store, the IndexedDB one's rule; `failPuts` makes every put reject. */
  function memoryStore(initial: Row[] = [], { failPuts = false } = {}) {
    let rows = [...initial];
    const store: OutboxStore<Row> = {
      records: (account) =>
        Promise.resolve(rows.filter((r) => r.account === account)),
      putCollapsed: (incoming) => {
        if (failPuts) return Promise.reject(new Error('QuotaExceededError'));
        const replaced = (r: Row) =>
          incoming.some((n) => n.account === r.account && n.key === r.key);
        rows = [...rows.filter((r) => !replaced(r)), ...incoming];
        return Promise.resolve();
      },
    };
    return { store, rows: () => rows };
  }

  it('a failed put leaves nothing pending: the next online tap goes straight on', async () => {
    const { store, rows } = memoryStore([], { failPuts: true });
    const result = await enqueue(store, '1', [row('a', 'wash:41')]);
    expect(result.outcome).toBe('unavailable');
    expect(rows()).toEqual([]);
    expect(await routesThroughOutbox(store, '1', false, ['wash:41'])).toBe(
      false,
    );
  });

  it('another tab’s committed record routes this tab’s online tap through it', async () => {
    // Written by another tab: this one never queued anything.
    const { store } = memoryStore([
      row('a', 'wear:41:2026-11-12'),
      row('b', 'wash:41', { state: 'failed' }),
      row('c', 'wash:7', { account: '2' }),
    ]);
    expect(
      await routesThroughOutbox(store, '1', false, ['wear:41:2026-11-12']),
    ).toBe(true);
    // A failure waits for Dismiss, not to be replayed; another account's is not this one's.
    expect(await routesThroughOutbox(store, '1', false, ['wash:41'])).toBe(
      false,
    );
    expect(await routesThroughOutbox(store, '1', false, ['wash:7'])).toBe(
      false,
    );
    expect(await routesThroughOutbox(store, '1', true, ['wash:7'])).toBe(true);
  });

  it('replaces the account’s record of the key and keeps another account’s', async () => {
    const { store, rows } = memoryStore([
      row('a', 'wear:41:2026-11-12'),
      row('b', 'wear:41:2026-11-12', { account: '2' }),
    ]);
    expect(await enqueue(store, '1', [row('c', 'wear:41:2026-11-12')])).toEqual(
      { outcome: 'queued' },
    );
    expect(rows().map((r) => r.id)).toEqual(['b', 'c']);
  });

  it('refuses past the cap, counting a replacement as no new record', async () => {
    const full = Array.from({ length: OUTBOX_MAX_PENDING }, (_, i) =>
      row(`r${i}`, `wash:${i + 1}`),
    );
    const { store, rows } = memoryStore(full);
    expect(await enqueue(store, '1', [row('new', 'wash:9999')])).toEqual({
      outcome: 'full',
    });
    expect(await enqueue(store, '1', [row('again', 'wash:1')])).toEqual({
      outcome: 'queued',
    });
    expect(rows()).toHaveLength(OUTBOX_MAX_PENDING);
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

describe('after a sync, the worker’s refetch', () => {
  it('acts only on the allowlist’s paths, each once', () => {
    expect(
      syncedWritePaths([
        '/wardrobe/41/wear',
        '/wardrobe/41/wear',
        '/trips/7/items/packed',
        '/wardrobe/41',
        'https://elsewhere.test/wardrobe/41/wear',
        '/wardrobe/41/wear?x=1',
        41,
        null,
      ]),
    ).toEqual(['/wardrobe/41/wear', '/trips/7/items/packed']);
    expect(syncedWritePaths('/wardrobe/41/wear')).toEqual([]);
    expect(syncedWritePaths(undefined)).toEqual([]);
  });

  it.each([
    [
      '/wardrobe/41/wear',
      ['/wardrobe/41', '/laundry'],
      ['/wardrobe/4', '/wardrobe/410', '/wardrobe', '/'],
    ],
    [
      '/wardrobe/41/washed',
      ['/wardrobe/41', '/laundry'],
      ['/wardrobe/41/edit', '/calendar'],
    ],
    [
      '/calendar/88/worn',
      ['/', '/calendar', '/laundry', '/trips/7'],
      ['/calendar/month', '/trips', '/trips/7/edit', '/wardrobe/88'],
    ],
    ['/trips/7/packed', ['/trips/7'], ['/trips/70', '/trips', '/', '/laundry']],
    ['/trips/7/items/packed', ['/trips/7'], ['/trips/8']],
    ['/wardrobe/41', [], ['/wardrobe/41', '/laundry']],
  ])(
    'refetches for %s exactly the pages that draw it',
    (write, shown, notShown) => {
      for (const page of shown)
        expect(showsQueuedWrite(write, page), page).toBe(true);
      for (const page of notShown)
        expect(showsQueuedWrite(write, page), page).toBe(false);
    },
  );
});

describe('queuedWritesGoneAtClaim', () => {
  it('deletes every other account’s records when the cache gets a new owner, keeping the claimant’s', () => {
    for (const owner of ['7', undefined]) {
      const gone = queuedWritesGoneAtClaim(owner, '41');
      expect(gone, String(owner)).toBeDefined();
      expect(gone?.('7')).toBe(true);
      expect(gone?.('412')).toBe(true);
      expect(gone?.(undefined)).toBe(true);
      expect(gone?.('41')).toBe(false);
    }
  });

  it('deletes none for the same owner or a signed-out page', () => {
    expect(queuedWritesGoneAtClaim('41', '41')).toBeUndefined();
    expect(queuedWritesGoneAtClaim('41', '')).toBeUndefined();
    expect(queuedWritesGoneAtClaim(undefined, '')).toBeUndefined();
  });

  it('keeps a record only in the header’s own spelling of the account', () => {
    // The owner and a record's account must agree in format: a number, or a
    // padded or prefixed id, is another account to the claim and goes.
    const gone = queuedWritesGoneAtClaim('7', '41');
    for (const spelling of [41, ' 41', '041', 'user:41']) {
      expect(gone?.(spelling), String(spelling)).toBe(true);
    }
  });
});

describe('retryDelayMs', () => {
  it('waits 5 s, doubling, at most 5 minutes', () => {
    expect([0, 1, 2, 3, 6, 7, 30].map(retryDelayMs)).toEqual([
      5_000, 5_000, 10_000, 20_000, 160_000, 300_000, 300_000,
    ]);
  });
});

describe('sharedUntilRejected', () => {
  it('shares one in-flight open, and retries after one rejects', async () => {
    let calls = 0;
    const open = sharedUntilRejected(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error('transient'))
        : Promise.resolve(calls);
    });
    const first = open();
    expect(open()).toBe(first);
    await expect(first).rejects.toThrow('transient');
    await expect(open()).resolves.toBe(2);
    await expect(open()).resolves.toBe(2);
    expect(calls).toBe(2);
  });
});
