import type { Logger } from '../../logger';
import { type Location, locationLabel } from '../../weather/location';
import { OutboundFetchError } from '../security/outbound-fetch';
import type { CacheRow } from './queries';

/**
 * One cache of Open-Meteo answers keyed by rounded location, in a table
 * (service.ts: the forecast, weather_forecast; the climate normals,
 * weather_normals). The discipline both share, so it lives once:
 * - a kept answer to another question than today's (`mismatch`: the
 *   forecast grouped in a zone other than APP_TIMEZONE, the normals of
 *   another run of years) is no answer at all: never served, however young,
 *   and never the fallback while the provider is down;
 * - an answer younger than `freshForMs` is served from the row;
 * - an older one is served at once and refreshed in the background (#114):
 *   the first page after the hour must not wait for Open-Meteo. Only a cold
 *   miss (no answer kept) waits, for at most the fetcher's bound. A one-shot
 *   decision that is not redone when the answer changes (the daily re-plan,
 *   the morning reminder, "Plan my week") asks with `{ fresh: true }`
 *   instead: it waits for the refresh like a cold miss and falls back to the
 *   stale answer only if the refresh fails;
 * - a failed refresh keeps the last good answer and records the attempt, so
 *   the provider is asked again only `retryAfterMs` later;
 * - one refresh per location at a time in this process, and no read of the
 *   row while one runs: an ask meanwhile is served the answer the refresh
 *   started from (or joins it, on a cold miss), so an ask that read the
 *   stale row just before the refresh saved can never fetch again. The pages
 *   of one household ask for the same place together. Across processes a
 *   duplicate fetch is harmless;
 * - a caller may hand in the row it read itself (`known`: userWeather joins
 *   it to the settings, one round trip instead of two). It is decided from
 *   only while no read or refresh of the location is under way and this
 *   process has not written the row since (`written`: a row whose
 *   attempted_at is older was read before that write); otherwise the ask is
 *   an ordinary one, so the rule above still holds.
 * A page is the same whether the refresh succeeds, fails or is still
 * running: it shows what it was served, and the next ask the new answer.
 *
 * Logs name the rounded location (`Forecast for 40.69,-73.97: ...`), never
 * the user: a refresh's start, then its outcome with its duration.
 */

export interface Cached<T> {
  value: T;
  /** When the answer was fetched: the "as of" the pages show. */
  fetchedAt: Date;
}

export interface LocationCacheOptions<T> {
  /** What the logs call it: "Forecast", "Climate normals". */
  name: string;
  freshForMs: number;
  retryAfterMs: number;
  now: () => Date;
  logger: Logger;
  read(location: Location): Promise<CacheRow<T> | undefined>;
  save(location: Location, value: T, at: Date): Promise<void>;
  recordFailure(location: Location, at: Date): Promise<void>;
  fetch(location: Location): Promise<T>;
  /** The answer's size for the log line: "16 days". */
  describe(value: T): string;
  /**
   * Why a kept answer no longer answers what is asked now ("for
   * America/Chicago, not America/New_York"), or null when it does.
   */
  mismatch(value: T): string | null;
}

export interface ReadOptions {
  /**
   * Wait for a stale answer's refresh rather than serve it (a job's
   * decision, not a page's display). The refresh's failure still falls back
   * to the stale answer; a refresh held back by `retryAfterMs` is not
   * started, so the stale answer is served then too.
   */
  fresh?: boolean;
}

/**
 * The location's row as the caller already read it, in a statement of its
 * own (userWeather reads it joined to the user's settings, #158): `row`
 * undefined when there was none.
 */
export interface KnownRow<T> {
  row: CacheRow<T> | undefined;
}

export interface LocationCache<T> {
  /**
   * The location's kept answer, stale or not (a stale one starts a
   * background refresh; `fresh` waits for it); the provider's, waited for,
   * when none is kept; null if the provider never answered. With `known`,
   * decided from that row instead of reading it again, unless this process
   * wrote the row since it was read or a read or refresh of it is under
   * way: then as without it, so a row read just before a refresh saved
   * never starts a second one.
   */
  get(
    location: Location,
    read?: ReadOptions,
    known?: KnownRow<T>,
  ): Promise<Cached<T> | null>;
  /**
   * Resolves once no refresh is running. The app's close awaits it before
   * ending the pool (a background refresh still has a row to save); specs
   * await it to see what a refresh stored.
   */
  settled(): Promise<void>;
}

/**
 * What one read of the row decided: the answer to serve now, and the
 * refresh it started (null when none was needed or allowed). Shared by the
 * asks that joined the read, each taking what its mode asks for.
 */
interface Decision<T> {
  kept: Cached<T> | null;
  refresh: Promise<Cached<T> | null> | null;
}

/** A refresh under way: the answer it started from, and its outcome. */
interface Refresh<T> {
  kept: Cached<T> | null;
  /** Never rejects: a failure is logged and resolves to `kept`. */
  done: Promise<Cached<T> | null>;
}

export function createLocationCache<T>(
  options: LocationCacheOptions<T>,
): LocationCache<T> {
  const { name, now, logger } = options;
  // Both keyed by locationLabel. `reading` holds the row's read and the
  // decision, `refreshing` the fetch and save the decision started. An ask
  // looks in `refreshing` first, and a lookup enters its refresh there before
  // its own promise settles, so no ask reads the row while a refresh runs.
  const reading = new Map<string, Promise<Decision<T>>>();
  const refreshing = new Map<string, Refresh<T>>();
  // When this process last wrote each location's row (a saved answer or a
  // failed attempt, both stamping attempted_at): a caller's row older than
  // that was read before the write and is not decided from.
  const written = new Map<string, number>();

  async function lookup(location: Location): Promise<Decision<T>> {
    return decide(location, await options.read(location));
  }

  /** Whether a caller's row predates this process's last write of it. */
  function outdated(key: string, row: CacheRow<T> | undefined): boolean {
    const at = written.get(key);
    return at !== undefined && (!row || row.attemptedAt.getTime() < at);
  }

  // Synchronous from the row to startRefresh, which enters `refreshing`
  // before any other ask can look.
  function decide(
    location: Location,
    row: CacheRow<T> | undefined,
  ): Decision<T> {
    const at = now().getTime();
    const kept = answering(location, lastGood(row));
    if (kept && at - kept.fetchedAt.getTime() < options.freshForMs) {
      return { kept, refresh: null };
    }
    // A refresh failed a moment ago: do not ask again yet.
    if (
      row &&
      at - row.attemptedAt.getTime() < options.retryAfterMs &&
      row.attemptedAt.getTime() !== row.fetchedAt?.getTime()
    ) {
      return { kept, refresh: null };
    }
    return { kept, refresh: startRefresh(location, kept).done };
  }

  /** What an ask gets from a decision: the refresh when it must wait. */
  function served(
    { kept, refresh }: Decision<T>,
    fresh: boolean,
  ): Promise<Cached<T> | null> {
    if (refresh && (fresh || !kept)) return refresh;
    return Promise.resolve(kept);
  }

  /** The kept answer, unless it answers another question than today's. */
  function answering(
    location: Location,
    kept: Cached<T> | null,
  ): Cached<T> | null {
    if (!kept) return null;
    const reason = options.mismatch(kept.value);
    if (reason === null) return kept;
    logger.info(
      `${name} for ${locationLabel(location)}: the one from ${kept.fetchedAt.toISOString()} is ${reason}; not served`,
    );
    return null;
  }

  function startRefresh(
    location: Location,
    kept: Cached<T> | null,
  ): Refresh<T> {
    const key = locationLabel(location);
    logger.info(
      `${name} for ${key}: refreshing; ${
        kept
          ? `the one from ${kept.fetchedAt.toISOString()} kept meanwhile`
          : 'none kept, the ask waits'
      }`,
    );
    const running: Refresh<T> = {
      kept,
      done: refresh(location, kept).finally(() => refreshing.delete(key)),
    };
    refreshing.set(key, running);
    return running;
  }

  async function refresh(
    location: Location,
    kept: Cached<T> | null,
  ): Promise<Cached<T> | null> {
    const label = locationLabel(location);
    const started = performance.now();
    try {
      const value = await options.fetch(location);
      const fetchedAt = now();
      await options.save(location, value, fetchedAt);
      written.set(label, fetchedAt.getTime());
      logger.info(
        `${name} for ${label}: ${options.describe(value)} in ${elapsed(started)} ms`,
      );
      return { value, fetchedAt };
    } catch (error) {
      logger.warn(
        `${name} for ${label} failed (${failureReason(error)}) after ${elapsed(started)} ms; ${
          kept
            ? `serving the one from ${kept.fetchedAt.toISOString()}`
            : 'none to serve'
        }`,
      );
      // Nobody awaits a background refresh, so it must never reject: an
      // unhandled rejection ends the process.
      const attemptedAt = now();
      await options
        .recordFailure(location, attemptedAt)
        .then(() => written.set(label, attemptedAt.getTime()))
        .catch((failure: unknown) => {
          logger.error(
            { err: failure },
            `${name} for ${label}: recording the failed attempt failed`,
          );
        });
      return kept;
    }
  }

  return {
    async get(location, read = {}, known) {
      const fresh = read.fresh ?? false;
      const key = locationLabel(location);
      const running = refreshing.get(key);
      if (running) {
        return served({ kept: running.kept, refresh: running.done }, fresh);
      }
      let looking = reading.get(key);
      if (!looking && known && !outdated(key, known.row)) {
        return served(decide(location, known.row), fresh);
      }
      if (!looking) {
        looking = lookup(location).finally(() => reading.delete(key));
        reading.set(key, looking);
      }
      return served(await looking, fresh);
    },

    async settled() {
      while (refreshing.size > 0) {
        await Promise.all([...refreshing.values()].map(({ done }) => done));
      }
    },
  };
}

function lastGood<T>(row: CacheRow<T> | undefined): Cached<T> | null {
  return row?.value && row.fetchedAt
    ? { value: row.value, fetchedAt: row.fetchedAt }
    : null;
}

/** The refusal's rule or the error's name, for the log; never a URL. */
export function failureReason(error: unknown): string {
  if (error instanceof OutboundFetchError) return error.reason;
  return error instanceof Error ? error.name : 'unknown';
}

export function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}
