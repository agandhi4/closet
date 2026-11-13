import { describe, expect, it } from 'vitest';
import { SYNC_ROOTS } from '../../db/sync-tables';
import { endOf, isExpired, KIND, type Position, startOf } from './cursor';
import { FEED, PENDING_FEED_RESOURCES } from './feed';

describe('the feed registry', () => {
  it('registers every synced root, or lists it pending #608', () => {
    const unregistered = SYNC_ROOTS.map((root) => root.table).filter(
      (table) => !(table in FEED),
    );
    expect(unregistered).toEqual([...PENDING_FEED_RESOURCES]);
  });

  it('names each resource once, with a titled schema for the spec', () => {
    const entries = Object.values(FEED);
    expect(new Set(entries.map((entry) => entry.name)).size).toBe(
      entries.length,
    );
    for (const entry of entries) expect(entry.schema.title).toBeTruthy();
  });
});

describe('isExpired: whether the prune may have dropped a deletion the cursor needs', () => {
  const at = (revision: number, kind: Position['kind'], floor = 0) => ({
    ...startOf(floor),
    revision,
    kind,
  });

  it.each([
    ['a fresh pass', startOf(5), 5, false],
    ['below the floor', at(4, KIND.row), 5, true],
    ['at the floor among its deletions', at(5, KIND.tombstone), 5, true],
    ['at the floor among its rows', at(5, KIND.row), 5, false],
    ['at the floor, past its end', endOf(5, 0), 5, false],
    ['above the floor', at(6, KIND.tombstone), 5, false],
    // A full sync begun at floor 5 pages through revision 0's rows: the
    // deletions at or below 5 were never needed.
    ['mid full sync, begun at this floor', at(0, KIND.row, 5), 5, false],
    ['mid full sync, the floor moved past it', at(0, KIND.row, 5), 6, true],
  ] as const)('%s', (_name, position, floor, expected) => {
    expect(isExpired(position, floor)).toBe(expected);
  });
});
