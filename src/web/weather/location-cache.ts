import type { Logger } from '../../logger';
import { type Location, locationLabel } from '../../weather/location';
import { OutboundFetchError } from '../security/outbound-fetch';
import type { CacheRow } from './queries';

/**
 * One cache of Open-Meteo answers keyed by rounded location, in a table
 * (service.ts: the forecast, weather_forecast; the climate normals,
 * weather_normals). The discipline both share, so it lives once:
 * - an answer younger than `freshForMs` is served from the row;
 * - an older one is refreshed, and a failed refresh keeps the last good
 *   answer and records the attempt, so the provider is asked again only
 *   `retryAfterMs` later;
 * - one lookup per location at a time in this process, the row's read
 *   included: the pages of one household ask for the same place together,
 *   and an ask that read the stale row just before another's refresh saved
 *   would fetch again. Across processes a duplicate fetch is harmless.
 * Nothing runs in the background: the asking request waits for at most one
 * bounded fetch.
 *
 * Logs name the rounded location (`Forecast for 40.69,-73.97: ...`), never
 * the user.
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
}

/** The location's answer, fresh when the provider answers; null if it never has. */
export type LocationCache<T> = (
  location: Location,
) => Promise<Cached<T> | null>;

export function createLocationCache<T>(
  options: LocationCacheOptions<T>,
): LocationCache<T> {
  const { name, now, logger } = options;
  const inFlight = new Map<string, Promise<Cached<T> | null>>();

  async function lookup(location: Location): Promise<Cached<T> | null> {
    const row = await options.read(location);
    const at = now().getTime();
    const kept = lastGood(row);
    if (kept && at - kept.fetchedAt.getTime() < options.freshForMs) {
      return kept;
    }
    // A refresh failed a moment ago: do not ask again yet.
    if (
      row &&
      at - row.attemptedAt.getTime() < options.retryAfterMs &&
      row.attemptedAt.getTime() !== row.fetchedAt?.getTime()
    ) {
      return kept;
    }
    return refresh(location, kept);
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
      logger.info(
        `${name} for ${label}: ${options.describe(value)} in ${elapsed(started)} ms`,
      );
      return { value, fetchedAt };
    } catch (error) {
      await options.recordFailure(location, now());
      logger.warn(
        `${name} for ${label} failed (${failureReason(error)}) after ${elapsed(started)} ms; ${
          kept
            ? `serving the one from ${kept.fetchedAt.toISOString()}`
            : 'none to serve'
        }`,
      );
      return kept;
    }
  }

  return (location) => {
    const key = locationLabel(location);
    const running = inFlight.get(key);
    if (running) return running;
    const looking = lookup(location).finally(() => inFlight.delete(key));
    inFlight.set(key, looking);
    return looking;
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
