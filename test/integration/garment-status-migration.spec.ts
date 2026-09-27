import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectionOptions, type DbConfig } from '../../src/db/client';
import { MIGRATIONS_FOLDER, runMigrations } from '../../src/db/migrate';
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
let folder: string;

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

interface Journal {
  entries: { tag: string }[];
}

/** A copy of drizzle/ that stops before the status migration. */
async function migrationsBeforeStatus(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'closet-drizzle-'));
  await mkdir(join(dir, 'meta'));
  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ) as Journal;
  const index = journal.entries.findIndex((e) =>
    e.tag.endsWith('_garment_status'),
  );
  expect(index).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, index);
  await writeFile(join(dir, 'meta', '_journal.json'), JSON.stringify(journal));
  for (const { tag } of journal.entries) {
    await copyFile(
      join(MIGRATIONS_FOLDER, `${tag}.sql`),
      join(dir, `${tag}.sql`),
    );
  }
  return dir;
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
  folder = await migrationsBeforeStatus();
  await migrate(drizzle(client), { migrationsFolder: folder });
});

afterEach(async () => {
  await client?.end();
  await database?.drop();
  if (folder) await rm(folder, { recursive: true, force: true });
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
    // Every other column as it was.
    const without = (row: Record<string, unknown>, columns: string[]) =>
      Object.fromEntries(
        Object.entries(row).filter(([column]) => !columns.includes(column)),
      );
    expect(
      after.rows.map((row) => without(row, ['status', 'replaces_garment_id'])),
    ).toEqual(before.rows.map((row) => without(row, ['archived'])));
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
      /USING btree \(owner_id, status, id DESC NULLS LAST\)/,
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
