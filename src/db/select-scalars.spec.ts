import { type SQL, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import type { Queryable } from './client';
import { selectScalars } from './select-scalars';

/** A Queryable whose execute answers `rows` and remembers the SQL it was sent. */
function fakeDb(rows: Record<string, unknown>[]) {
  const execute = vi.fn((query: SQL) => {
    void query;
    return Promise.resolve({ rows });
  });
  return { db: { execute } as unknown as Queryable, execute };
}

const dialect = new PgDialect();
const sent = (execute: ReturnType<typeof fakeDb>['execute']) =>
  dialect.sqlToQuery(execute.mock.calls[0][0]);

describe('selectScalars', () => {
  it('sends nothing for an empty selection, or one whose columns are all left out', async () => {
    const { db, execute } = fakeDb([]);
    expect(await selectScalars(db, {})).toEqual({});
    expect(await selectScalars(db, { a: undefined, b: undefined })).toEqual({});
    expect(execute).not.toHaveBeenCalled();
  });

  it('reads every column in one statement without a FROM, each under its own name', async () => {
    const { db, execute } = fakeDb([{ count: 3, names: ['a'] }]);
    const row = await selectScalars(db, {
      count: sql<number>`(select count(*)::int from garment where owner_id = ${7})`,
      names: sql<string[]>`(select json_agg(name) from capsule)`,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    const { sql: text, params } = sent(execute);
    expect(text).toBe(
      'select (select count(*)::int from garment where owner_id = $1) as "count", (select json_agg(name) from capsule) as "names"',
    );
    expect(params).toEqual([7]);
    expect(row).toEqual({ count: 3, names: ['a'] });
  });

  it('leaves an undefined column out of the statement and out of the row', async () => {
    const { db, execute } = fakeDb([{ kept: 1 }]);
    const row = await selectScalars(db, {
      kept: sql<number>`1`,
      skipped: undefined as SQL<number> | undefined,
    });
    expect(sent(execute).sql).toBe('select 1 as "kept"');
    expect(row).toEqual({ kept: 1 });
    expect(row.skipped).toBeUndefined();
  });

  it('answers the one row as the driver decoded it: a null stays null, an empty list stays empty', async () => {
    const { db } = fakeDb([{ none: null, list: [] }]);
    const row = await selectScalars(db, {
      none: sql<number | null>`(select 1 where false)`,
      list: sql<string[]>`coalesce(json_agg(1), '[]')`,
    });
    expect(row.none).toBeNull();
    expect(row.list).toEqual([]);
  });

  it('quotes a column name as an identifier, never as SQL', async () => {
    const { db, execute } = fakeDb([{}]);
    await selectScalars(db, { 'a" from x; --': sql`1` });
    expect(sent(execute).sql).toBe('select 1 as "a"" from x; --"');
  });
});
