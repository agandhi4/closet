import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { selectScalars } from '../../src/db/select-scalars';
import { createTestApp, type TestApp } from './harness';

/**
 * selectScalars against Postgres and node-postgres as they decode the row
 * (src/db/select-scalars.ts, whose docstring these cases back): the unit
 * spec covers what it sends, this what comes back.
 */
describe('selectScalars on Postgres', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  it('answers one row: counts as numbers, lists as arrays, a subquery that finds nothing as null', async () => {
    const row = await selectScalars(t.db, {
      count: sql<number>`(select count(*)::int from generate_series(1, 3))`,
      list: sql<
        number[]
      >`(select json_agg(n order by n) from generate_series(1, 2) as n)`,
      nothing: sql<number | null>`(select 1 where false)`,
      emptyRaw: sql<number[] | null>`(select json_agg(1) where false)`,
      empty: sql<number[]>`(select coalesce(json_agg(1), '[]') where false)`,
    });
    expect(row).toEqual({
      count: 3,
      list: [1, 2],
      nothing: null,
      emptyRaw: null,
      empty: [],
    });
  });

  it('decodes a date inside JSON as its ISO string, never a Date', async () => {
    const row = await selectScalars(t.db, {
      day: sql<string>`(select json_build_object('day', date '2026-09-28')->>'day')`,
      inObject: sql<{
        day: string;
      }>`(select json_build_object('day', date '2026-09-28'))`,
    });
    expect(row.day).toBe('2026-09-28');
    expect(row.inObject.day).toBe('2026-09-28');
    expect(row.inObject.day).not.toBeInstanceOf(Date);
  });
});
