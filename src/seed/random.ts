import { type Random, seededRandom } from '../random';

/**
 * The seed's only source of randomness: never Math.random, so the same
 * persona and anchor give the same history on every run (and every CI
 * screenshot is the same). A stream is keyed by what it decides, e.g.
 * `stream('demo', 'outfit', day)`: each decision has its own sequence, so
 * a subsystem added later (wears #7, trips #10) draws from new keys and
 * never shifts an existing one's draws, which would reshuffle the whole
 * history.
 */

/**
 * Bump to reshuffle every persona's history on purpose (a new key for
 * every stream).
 */
export const SEED_VERSION = 1;

export function stream(...key: (string | number)[]): Random {
  return seededRandom(SEED_VERSION, ...key);
}
