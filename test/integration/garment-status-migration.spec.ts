import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectionOptions, type DbConfig } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { migrateBefore } from '../support/migrate-before';
import {
  createScratchDatabase,
  type ScratchDatabase,
} from '../support/scratch-database';
import { silentLogger } from './logger';

/**
 * The status migration (drizzle/NNNN_garment_status.sql) on a database the
 * previous build migrated, holding garments in and out of the archive as
 * production does: archived true becomes 'archived', false 'closet', every
 * other column is kept, the grid's index is rebuilt on the status, the old
 * column and index are gone, and the new constraints hold. A batch that
 * fails part way leaves the database as it was.
 */

let database: ScratchDatabase;
let client: Client;

function configOf(env: Record<string, string>): DbConfig {
  return {
    host: env.DATABASE_HOST,
    port: Number(env.DATABASE_PORT),
    database: env.DATABASE_SCHEMA,
    user: env.DATABASE_USER,
    password: env.DATABASE_PASS,
    ssl: false,
  };
}

async function insert(text: string, values: unknown[] = []): Promise<number> {
  return (await client.query<{ id: number }>(`${text} returning id`, values))
    .rows[0].id;
}

/** A user with a closet garment, an archived one and a tagged one, as the old schema stored them. */
async function productionShapedRows() {
  const owner = await insert(
    `insert into "user" (email, password) values ('owner@example.com', 'x')`,
  );
  const garment = (name: string, archived: boolean) =>
    insert(
      `insert into garment (shareable_id, name, category, owner_id, archived,
                            type, warmth, price, source_url, quantity, condition)
       values (gen_random_uuid()::text, $1, 'tops', $2, $3,
               't-shirt', 2, 24.90, 'https://shop.example/tee', 3, 'replace_soon')`,
      [name, owner, archived],
    );
  return {
    owner,
    kept: await garment('White tee', false),
    archived: await garment('Old grey tee', true),
  };
}

async function columnsOf(table: string): Promise<string[]> {
  const { rows } = await client.query<{ column_name: string }>(
    `select column_name from information_schema.columns
     where table_name = $1 order by column_name`,
    [table],
  );
  return rows.map((row) => row.column_name);
}

async function indexDefinition(name: string): Promise<string | undefined> {
  const { rows } = await client.query<{ indexdef: string }>(
    `select indexdef from pg_indexes where indexname = $1`,
    [name],
  );
  return rows[0]?.indexdef;
}

beforeEach(async () => {
  database = await createScratchDatabase('closet_it');
  client = new Client(connectionOptions(configOf(database.env)));
  await client.connect();
  await migrateBefore(client, 'garment_status');
});

afterEach(async () => {
  await client?.end();
  await database?.drop();
});

describe('garment status (the garment_status migration)', () => {
  it('maps archived to status and keeps every other value', async () => {
    const { kept, archived } = await productionShapedRows();
    const before = await client.query<Record<string, unknown>>(
      `select * from garment order by id`,
    );

    await runMigrations(configOf(database.env), silentLogger);

    const after = await client.query<Record<string, unknown>>(
      `select * from garment order by id`,
    );
    expect(
      after.rows.map(({ id, status, replaces_garment_id }) => ({
        id,
        status,
        replaces_garment_id,
      })),
    ).toEqual([
      { id: kept, status: 'closet', replaces_garment_id: null },
      { id: archived, status: 'archived', replaces_garment_id: null },
    ]);
    // Every other column as it was (the colours are a later migration's:
    // garment-colors-migration.spec.ts; so are the columns later
    // migrations add).
    const unchanged = Object.keys(before.rows[0]).filter(
      (column) => !['archived', 'color'].includes(column),
    );
    const only = (row: Record<string, unknown>) =>
      Object.fromEntries(unchanged.map((column) => [column, row[column]]));
    expect(after.rows.map(only)).toEqual(before.rows.map(only));
  });

  it('rebuilds the grid index on the status and drops the old column', async () => {
    await runMigrations(configOf(database.env), silentLogger);

    expect(await columnsOf('garment')).not.toContain('archived');
    expect(await columnsOf('garment')).toEqual(
      expect.arrayContaining(['status', 'replaces_garment_id']),
    );
    expect(
      await indexDefinition('garment_owner_id_archived_id_index'),
    ).toBeUndefined();
    expect(await indexDefinition('garment_owner_id_status_id_index')).toMatch(
      // 0014 built it id DESC NULLS LAST; 0031 (#175) rebuilt it as id DESC.
      /USING btree \(owner_id, status, id DESC\)/,
    );
  });

  it('refuses a status outside the machine, and a garment replacing itself', async () => {
    const { owner, kept, archived } = await productionShapedRows();
    await runMigrations(configOf(database.env), silentLogger);

    await expect(
      client.query(`update garment set status = 'lost' where id = $1`, [kept]),
    ).rejects.toThrow(/garment_status_check/);
    await expect(
      client.query(
        `update garment set replaces_garment_id = id where id = $1`,
        [kept],
      ),
    ).rejects.toThrow(/garment_replaces_garment_id_check/);

    // A wishlist item replacing the old tee; deleting the tee clears it.
    const wanted = await insert(
      `insert into garment (shareable_id, name, category, owner_id, status, replaces_garment_id)
       values (gen_random_uuid()::text, 'Charcoal tee', 'tops', $1, 'wishlist', $2)`,
      [owner, archived],
    );
    await client.query(`delete from garment where id = $1`, [archived]);
    const { rows } = await client.query(
      `select status, replaces_garment_id from garment where id = $1`,
      [wanted],
    );
    expect(rows).toEqual([{ status: 'wishlist', replaces_garment_id: null }]);
  });

  it('leaves the database as it was when the batch fails part way', async () => {
    const { kept, archived } = await productionShapedRows();
    // An index already holding the new index's name (names are per schema)
    // makes the migration's CREATE INDEX fail after the status was written.
    await client.query(
      `create index garment_owner_id_status_id_index on "user" (email)`,
    );

    await expect(
      runMigrations(configOf(database.env), silentLogger),
    ).rejects.toThrow();

    expect(await columnsOf('garment')).toContain('archived');
    expect(await columnsOf('garment')).not.toContain('status');
    const { rows } = await client.query(
      `select id, archived from garment order by id`,
    );
    expect(rows).toEqual([
      { id: kept, archived: false },
      { id: archived, archived: true },
    ]);
    expect(
      await indexDefinition('garment_owner_id_archived_id_index'),
    ).toBeDefined();
  });
});
