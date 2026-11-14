import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../../project-root';

/**
 * setTripDestination is the one writer of a trip's name+location+zone
 * together, and updateTrip only clears them (#678), so a zone never outlives
 * its place. Behaviour per writer: the page and the API PUT (trips.spec.ts;
 * api-weather.spec.ts "asks a Tokyo trip's days in Tokyo's zone") and the
 * seed reach it through locateTrip / setTripDestination; no MCP tool or sync
 * route writes a trip's location. This spec holds the rest: no other module
 * writes the trip's columns.
 */

const SRC = join(PROJECT_ROOT, 'src');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.spec\.tsx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

const files = sources(SRC).map((path) => ({
  name: relative(SRC, path),
  text: readFileSync(path, 'utf8'),
}));

const matching = (pattern: RegExp) =>
  files.filter(({ text }) => pattern.test(text)).map(({ name }) => name);

describe('the writers of a trip’s destination', () => {
  it('only the trip queries write the trip table', () => {
    expect(
      matching(
        /\.(?:update|insert)\(\s*trip\s*\)|(?:update|insert into)\s+\$\{trip\}/,
      ),
    ).toEqual(['web/trips/queries.ts']);
  });

  it('only setTripDestination sets a location or zone; updateTrip only clears them', () => {
    const { text } = files.find(({ name }) => name === 'web/trips/queries.ts')!;
    const assigned = [
      ...text.matchAll(/\b(?:time_zone|timeZone)\s*[=:]\s*([^,\n]+)/g),
    ]
      .map((m) => m[1].trim())
      .filter((rhs) => !/^(?:trip\.|\$\{trip\.|string\b)/.test(rhs));
    expect(assigned.filter((rhs) => !/^null\b/.test(rhs))).toEqual([
      'place.location.timeZone',
    ]);
    expect(text.match(/latitude: place\.location\.latitude/g)).toHaveLength(1);
  });

  it('the page, API and seed reach it only through the shared writer', () => {
    expect(matching(/\bsetTripDestination\(/).sort()).toEqual([
      'seed/seed.ts',
      'web/trips/queries.ts',
      'web/trips/trip-actions.ts',
    ]);
    expect(matching(/\blocateTrip\(/).sort()).toEqual([
      'web/trips/api-routes.ts',
      'web/trips/routes.tsx',
      'web/trips/trip-actions.ts',
    ]);
  });
});
