import { Migration } from '@mikro-orm/migrations';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Migration20260925181256 } from './postgres/Migration20260925181256';
import { Migration20260925183958 } from './postgres/Migration20260925183958';

/**
 * Postgres index migrations run on app boot against the live database.
 * Every index must be built CONCURRENTLY (no write lock) and idempotently,
 * which in turn requires the migration to run outside a transaction. Add
 * every new index-only Postgres migration to this list.
 */
const INDEX_MIGRATIONS: { name: string; migration: typeof Migration }[] = [
  { name: 'Migration20260925181256', migration: Migration20260925181256 },
  { name: 'Migration20260925183958', migration: Migration20260925183958 },
];

describe.each(INDEX_MIGRATIONS)('$name (postgres indexes)', ({
  name,
  migration,
}) => {
  const source = readFileSync(join(__dirname, 'postgres', `${name}.ts`), 'utf8');
  // Every SQL statement is a template literal handed to addSql.
  const statements = (verb: 'create' | 'drop') =>
    [...source.matchAll(/`((?:create|drop) index[^`]*)`/g)]
      .map((match) => match[1])
      .filter((sql) => sql.startsWith(verb));
  const indexName = (sql: string) => /"([a-z_]+)"/.exec(sql)![1];

  it('opts out of the migrator transaction', () => {
    const instance = Object.create(migration.prototype) as Migration;
    expect(instance.isTransactional()).toBe(false);
  });

  it('creates every index concurrently and idempotently', () => {
    const creates = statements('create');
    expect(creates.length).toBeGreaterThan(0);
    for (const sql of creates) {
      expect(sql).toMatch(/^create index concurrently if not exists "/);
    }
  });

  it('drops every index it creates, concurrently and idempotently', () => {
    const drops = statements('drop');
    expect(drops.map(indexName).sort()).toEqual(
      statements('create').map(indexName).sort(),
    );
    for (const sql of drops) {
      expect(sql).toMatch(/^drop index concurrently if exists "/);
    }
  });
});
