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
 * The colours migration (drizzle/NNNN_garment_colors.sql, #28) on a
 * database the previous build migrated, holding garments whose `color` is
 * the comma-joined text every earlier build wrote, plus what a hand edit or
 * an old client could leave there: stray spaces, capitals, repeats, a
 * trailing comma, an empty string. Each becomes a set in GARMENT_COLORS
 * order (null for none), every other column is kept, the old column goes
 * and the new check holds. A colour outside the set aborts the whole batch
 * and names its rows.
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

/** A copy of drizzle/ that stops before the colours migration. */
async function migrationsBeforeColors(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'closet-drizzle-'));
  await mkdir(join(dir, 'meta'));
  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ) as Journal;
  const index = journal.entries.findIndex((e) =>
    e.tag.endsWith('_garment_colors'),
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

let owner: number;

/** A garment as the previous build stored it, with `color` as given. */
function garmentWith(color: string | null, name = 'Garment') {
  return insert(
    `insert into garment (shareable_id, name, category, owner_id, color,
                          type, warmth, materials, price, quantity, condition)
     values (gen_random_uuid()::text, $1, 'tops', $2, $3,
             't-shirt', 2, '{cotton}', 24.90, 3, 'replace_soon')`,
    [name, owner, color],
  );
}

async function columnsOf(table: string): Promise<Record<string, string>> {
  const { rows } = await client.query<{ name: string; type: string }>(
    `select column_name as name, data_type as type
       from information_schema.columns
      where table_name = $1 order by column_name`,
    [table],
  );
  return Object.fromEntries(rows.map((row) => [row.name, row.type]));
}

beforeEach(async () => {
  database = await createScratchDatabase('closet_it');
  client = new Client(connectionOptions(configOf(database.env)));
  await client.connect();
  folder = await migrationsBeforeColors();
  await migrate(drizzle(client), { migrationsFolder: folder });
  owner = await insert(
    `insert into "user" (email, password) values ('owner@example.com', 'x')`,
  );
});

afterEach(async () => {
  await client?.end();
  await database?.drop();
  if (folder) await rm(folder, { recursive: true, force: true });
});

describe('garment colours (the garment_colors migration)', () => {
  it('turns each stored list into a set in the list’s order, and keeps every other value', async () => {
    const cases: [string | null, string[] | null][] = [
      // What the garment form wrote: its checkboxes' order.
      ['red,blue', ['red', 'blue']],
      ['black', ['black']],
      // Out of order and repeated.
      ['white,blue', ['blue', 'white']],
      ['grey,grey,black,grey', ['black', 'grey']],
      // Whitespace and case.
      [' Red , BLUE ', ['red', 'blue']],
      ['\tpattern\n', ['pattern']],
      // A trailing comma, a blank item, blank lists.
      ['green,', ['green']],
      ['silver,,gold', ['gold', 'silver']],
      ['', null],
      [',', null],
      [' , ', null],
      [null, null],
    ];
    const ids: number[] = [];
    for (const [color] of cases) ids.push(await garmentWith(color));
    const before = await client.query<Record<string, unknown>>(
      `select * from garment order by id`,
    );

    await runMigrations(configOf(database.env), silentLogger);

    const after = await client.query<Record<string, unknown>>(
      `select * from garment order by id`,
    );
    expect(after.rows.map(({ id, colors }) => ({ id, colors }))).toEqual(
      cases.map(([, colors], i) => ({ id: ids[i], colors })),
    );
    // Every other column as it was (columns later migrations add are
    // theirs to judge).
    const unchanged = Object.keys(before.rows[0]).filter(
      (key) => key !== 'color',
    );
    const only = (row: Record<string, unknown>) =>
      Object.fromEntries(unchanged.map((key) => [key, row[key]]));
    expect(after.rows.map(only)).toEqual(before.rows.map(only));
  });

  it('drops the old column and keeps the colour set in the database', async () => {
    const id = await garmentWith('red,blue');
    await runMigrations(configOf(database.env), silentLogger);

    const columns = await columnsOf('garment');
    expect(columns).not.toHaveProperty('color');
    expect(columns).toMatchObject({ colors: 'ARRAY', materials: 'ARRAY' });

    const write = (colors: string[]) =>
      client.query(`update garment set colors = $1 where id = $2`, [
        colors,
        id,
      ]);
    await expect(write(['red', 'teal'])).rejects.toThrow(
      /garment_colors_check/,
    );
    await expect(write([])).rejects.toThrow(/garment_colors_check/);
    await write(['pattern', 'other']);
    await client.query(`update garment set colors = null where id = $1`, [id]);
  });

  it('aborts, naming each row, rather than drop a colour outside the set', async () => {
    const kept = await garmentWith('red,blue', 'Kept');
    const scarf = await garmentWith('red, Teal', 'Scarf');
    const hat = await garmentWith('mauve', 'Hat');

    const run = runMigrations(configOf(database.env), silentLogger);
    await expect(run).rejects.toThrow(
      `colours outside the built-in set in row(s) ${scarf} ('red, Teal'), ${hat} ('mauve')`,
    );

    // The whole batch rolled back: the text column, as it was.
    const columns = await columnsOf('garment');
    expect(columns).toMatchObject({ color: 'text' });
    expect(columns).not.toHaveProperty('colors');
    const { rows } = await client.query(
      `select id, color from garment order by id`,
    );
    expect(rows).toEqual([
      { id: kept, color: 'red,blue' },
      { id: scarf, color: 'red, Teal' },
      { id: hat, color: 'mauve' },
    ]);
  });
});
