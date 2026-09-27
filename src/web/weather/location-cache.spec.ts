import { describe, expect, it } from 'vitest';
import { captureLogs } from '../../../test/support/log-capture';
import type { Location } from '../../weather/location';
import { OutboundFetchError } from '../security/outbound-fetch';
import { createLocationCache } from './location-cache';
import type { CacheRow } from './queries';

/**
 * The cache's discipline (#114) against an in-memory row and a provider the
 * spec answers by hand: a stale answer is served at once and refreshed once
 * in the background, a failed refresh keeps it, and only a cold miss waits.
 */

const HERE: Location = { latitude: 40.69, longitude: -73.98 };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = new Date('2026-09-27T12:00:00Z');

interface Pending {
  resolve(value: string): void;
  reject(error: unknown): void;
}

function setup(row?: CacheRow<string>) {
  const { logger, logs } = captureLogs();
  let stored = row;
  let clock = NOW;
  const pending: Pending[] = [];
  const calls = { read: 0, fetch: 0, save: 0, recordFailure: 0 };
  let failRecording = false;

  const cache = createLocationCache<string>({
    name: 'Forecast',
    freshForMs: HOUR,
    retryAfterMs: 10 * MINUTE,
    now: () => clock,
    logger,
    read: () => {
      calls.read += 1;
      return Promise.resolve(stored);
    },
    save: (_location, value, at) => {
      calls.save += 1;
      stored = { value, fetchedAt: at, attemptedAt: at };
      return Promise.resolve();
    },
    recordFailure: (_location, at) => {
      calls.recordFailure += 1;
      if (failRecording) return Promise.reject(new Error('pool ended'));
      stored = {
        value: stored?.value ?? null,
        fetchedAt: stored?.fetchedAt ?? null,
        attemptedAt: at,
      };
      return Promise.resolve();
    },
    fetch: () => {
      calls.fetch += 1;
      return new Promise<string>((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    },
    describe: (value) => `"${value}"`,
    // An answer to another question (a zone or years no longer asked for).
    mismatch: (value) =>
      value.startsWith('other:') ? 'for Chicago, not New York' : null,
  });

  return {
    cache,
    logs,
    calls,
    pending,
    row: () => stored,
    at: (offsetMs: number) => {
      clock = new Date(NOW.getTime() + offsetMs);
    },
    failRecording: () => {
      failRecording = true;
    },
  };
}

/** Every microtask queued so far has run: the asks have read and decided. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const staleRow = (): CacheRow<string> => ({
  value: 'old',
  fetchedAt: new Date(NOW.getTime() - 2 * HOUR),
  attemptedAt: new Date(NOW.getTime() - 2 * HOUR),
});

describe('createLocationCache', () => {
  it('serves a fresh answer from the row without asking the provider', async () => {
    const fetchedAt = new Date(NOW.getTime() - 59 * MINUTE);
    const s = setup({ value: 'kept', fetchedAt, attemptedAt: fetchedAt });
    await expect(s.cache.get(HERE)).resolves.toEqual({
      value: 'kept',
      fetchedAt,
    });
    expect(s.calls.fetch).toBe(0);
    expect(s.logs.records).toEqual([]);
  });

  it('serves a stale answer at once and refreshes it once in the background, concurrent asks included', async () => {
    const s = setup(staleRow());
    const old = { value: 'old', fetchedAt: staleRow().fetchedAt };

    // None of these waits for the provider, which has not answered yet.
    const asks = await Promise.all([
      s.cache.get(HERE),
      s.cache.get(HERE),
      s.cache.get(HERE),
    ]);
    expect(asks).toEqual([old, old, old]);
    expect(s.calls.fetch).toBe(1);

    // An ask while the refresh runs is served the same answer without
    // reading the row or starting another fetch.
    await flush();
    const readsSoFar = s.calls.read;
    await expect(s.cache.get(HERE)).resolves.toEqual(old);
    expect(s.calls.read).toBe(readsSoFar);
    expect(s.calls.fetch).toBe(1);

    s.at(2 * 1000);
    s.pending[0].resolve('new');
    await s.cache.settled();
    expect(s.calls.save).toBe(1);
    expect(s.row()?.value).toBe('new');

    // The next ask reads the new row; nothing more is fetched.
    await expect(s.cache.get(HERE)).resolves.toEqual({
      value: 'new',
      fetchedAt: new Date(NOW.getTime() + 2 * 1000),
    });
    expect(s.calls.fetch).toBe(1);

    expect(s.logs.messages('info')).toEqual([
      'Forecast for 40.69,-73.98: refreshing; the one from 2026-09-27T10:00:00.000Z kept meanwhile',
      expect.stringMatching(/^Forecast for 40\.69,-73\.98: "new" in \d+ ms$/),
    ]);
  });

  it("waits for a stale answer's refresh on a fresh read (a job's decision), through the same single flight", async () => {
    const s = setup(staleRow());
    const old = { value: 'old', fetchedAt: staleRow().fetchedAt };
    let answered = false;
    const job = s.cache.get(HERE, { fresh: true }).then((value) => {
      answered = true;
      return value;
    });
    // A page asking meanwhile is served the stale answer at once, and the
    // two share one fetch.
    await expect(s.cache.get(HERE)).resolves.toEqual(old);
    await flush();
    expect(answered).toBe(false);
    expect(s.calls.fetch).toBe(1);
    // A second job joins the refresh in flight.
    const second = s.cache.get(HERE, { fresh: true });

    s.at(1000);
    s.pending[0].resolve('new');
    const answer = { value: 'new', fetchedAt: new Date(NOW.getTime() + 1000) };
    await expect(job).resolves.toEqual(answer);
    await expect(second).resolves.toEqual(answer);
    expect(s.calls.fetch).toBe(1);
  });

  it('falls back to the stale answer on a fresh read whose refresh fails', async () => {
    const s = setup(staleRow());
    const job = s.cache.get(HERE, { fresh: true });
    await flush();
    s.pending[0].reject(new OutboundFetchError('timeout', 'timed out'));
    await expect(job).resolves.toEqual({
      value: 'old',
      fetchedAt: staleRow().fetchedAt,
    });
    // Held back by the retry pause: served stale, not waited on.
    s.at(MINUTE);
    await expect(s.cache.get(HERE, { fresh: true })).resolves.toEqual({
      value: 'old',
      fetchedAt: staleRow().fetchedAt,
    });
    expect(s.calls.fetch).toBe(1);
  });

  it('keeps the old answer when the refresh fails, and waits before asking again', async () => {
    const s = setup(staleRow());
    const old = { value: 'old', fetchedAt: staleRow().fetchedAt };

    await expect(s.cache.get(HERE)).resolves.toEqual(old);
    s.pending[0].reject(new OutboundFetchError('http-status', 'HTTP 500', 500));
    await s.cache.settled();

    expect(s.calls.save).toBe(0);
    expect(s.calls.recordFailure).toBe(1);
    expect(s.row()).toMatchObject({ value: 'old', attemptedAt: NOW });
    expect(s.logs.messages('warn')).toEqual([
      expect.stringMatching(
        /^Forecast for 40\.69,-73\.98 failed \(http-status\) after \d+ ms; serving the one from 2026-09-27T10:00:00\.000Z$/,
      ),
    ]);

    s.at(9 * MINUTE);
    await expect(s.cache.get(HERE)).resolves.toEqual(old);
    expect(s.calls.fetch).toBe(1);

    s.at(11 * MINUTE);
    await expect(s.cache.get(HERE)).resolves.toEqual(old);
    expect(s.calls.fetch).toBe(2);
    s.pending[1].resolve('new');
    await s.cache.settled();
    expect(s.row()?.value).toBe('new');
  });

  it('never rejects in the background, even when recording the failure fails', async () => {
    const s = setup(staleRow());
    s.failRecording();
    await s.cache.get(HERE);
    s.pending[0].reject(new Error('socket hang up'));
    await s.cache.settled();
    expect(s.row()?.value).toBe('old');
    expect(s.logs.messages('error')).toEqual([
      'Forecast for 40.69,-73.98: recording the failed attempt failed',
    ]);
  });

  it('fetches inline on a cold miss, once for simultaneous asks', async () => {
    const s = setup();
    let answered = false;
    const asks = Promise.all([s.cache.get(HERE), s.cache.get(HERE)]).then(
      (values) => {
        answered = true;
        return values;
      },
    );
    await flush();
    expect(s.calls.fetch).toBe(1);
    expect(answered).toBe(false);

    // A third ask joins the fetch in flight.
    const third = s.cache.get(HERE);
    await flush();
    expect(s.calls.fetch).toBe(1);

    s.pending[0].resolve('first');
    const answer = { value: 'first', fetchedAt: NOW };
    await expect(asks).resolves.toEqual([answer, answer]);
    await expect(third).resolves.toEqual(answer);
    expect(s.row()?.value).toBe('first');
    expect(s.logs.messages('info')[0]).toBe(
      'Forecast for 40.69,-73.98: refreshing; none kept, the ask waits',
    );
  });

  it('never serves an answer to another question, however young, and waits for the new one', async () => {
    const fetchedAt = new Date(NOW.getTime() - MINUTE);
    const s = setup({ value: 'other:days', fetchedAt, attemptedAt: fetchedAt });
    const ask = s.cache.get(HERE);
    await flush();
    expect(s.calls.fetch).toBe(1);
    s.pending[0].resolve('days');
    await expect(ask).resolves.toEqual({ value: 'days', fetchedAt: NOW });
    expect(s.logs.messages('info').slice(0, 2)).toEqual([
      'Forecast for 40.69,-73.98: the one from 2026-09-27T11:59:00.000Z is for Chicago, not New York; not served',
      'Forecast for 40.69,-73.98: refreshing; none kept, the ask waits',
    ]);
  });

  it('never falls back to an answer to another question while the provider is down', async () => {
    const fetchedAt = new Date(NOW.getTime() - 2 * HOUR);
    const s = setup({ value: 'other:days', fetchedAt, attemptedAt: fetchedAt });
    const ask = s.cache.get(HERE);
    await flush();
    s.pending[0].reject(new OutboundFetchError('timeout', 'timed out'));
    await expect(ask).resolves.toBeNull();
    // Kept in the row (the next good answer replaces it), never served.
    expect(s.row()?.value).toBe('other:days');
    s.at(MINUTE);
    await expect(s.cache.get(HERE)).resolves.toBeNull();
    expect(s.calls.fetch).toBe(1);
  });

  it('answers null on a cold miss the provider fails', async () => {
    const s = setup();
    const ask = s.cache.get(HERE);
    await flush();
    s.pending[0].reject(new OutboundFetchError('timeout', 'timed out'));
    await expect(ask).resolves.toBeNull();
    expect(s.row()).toMatchObject({ value: null, attemptedAt: NOW });
    expect(s.logs.messages('warn')).toEqual([
      expect.stringMatching(/failed \(timeout\) after \d+ ms; none to serve$/),
    ]);
  });
});
