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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectionOptions, type DbConfig } from '../../src/db/client';
import { MIGRATIONS_FOLDER, runMigrations } from '../../src/db/migrate';
import {
  createScratchDatabase,
  type ScratchDatabase,
} from '../support/scratch-database';
import { silentLogger } from './logger';

/**
 * The occasions migration (drizzle/NNNN_outfit_calendar_occasion.sql) on a
 * database with calendar entries, worn and planned, as production has: every
 * one becomes all day, and nothing else about it (or its wears) changes.
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

/** A copy of drizzle/ that stops before the occasions migration. */
async function migrationsBeforeOccasions(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'closet-drizzle-'));
  await mkdir(join(dir, 'meta'));
  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ) as Journal;
  const index = journal.entries.findIndex((e) =>
    e.tag.endsWith('_outfit_calendar_occasion'),
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

beforeAll(async () => {
  database = await createScratchDatabase('closet_it');
  client = new Client(connectionOptions(configOf(database.env)));
  await client.connect();
  folder = await migrationsBeforeOccasions();
  await migrate(drizzle(client), { migrationsFolder: folder });
});

afterAll(async () => {
  await client?.end();
  await database?.drop();
  if (folder) await rm(folder, { recursive: true, force: true });
});

describe('occasions (the outfit_calendar_occasion migration)', () => {
  it('makes every existing entry all day, keeping the rest of it and its wears', async () => {
    const insert = async (text: string, values: unknown[]) =>
      (await client.query<{ id: number }>(`${text} returning id`, values))
        .rows[0].id;
    const owner = await insert(
      `insert into "user" (email, password) values ('owner@example.com', 'x')`,
      [],
    );
    const tee = await insert(
      `insert into garment (shareable_id, name, category, owner_id)
       values (gen_random_uuid()::text, 'Tee', 'tops', $1)`,
      [owner],
    );
    const outfit = (name: string) =>
      insert(
        `insert into outfit (shareable_id, name, owner_id)
         values (gen_random_uuid()::text, $1, $2)`,
        [name, owner],
      );
    const day = await outfit('Day');
    const night = await outfit('Night');
    // Two outfits on one day were already possible: both become all day.
    const worn = await insert(
      `insert into outfit_calendar (day, outfit_id, owner_id, worn_at)
       values ('2026-09-21', $1, $2, '2026-09-22T01:00:00Z')`,
      [day, owner],
    );
    const planned = await insert(
      `insert into outfit_calendar (day, outfit_id, owner_id)
       values ('2026-09-21', $1, $2)`,
      [night, owner],
    );
    await client.query(
      `insert into garment_wear (garment_id, owner_id, day, outfit_calendar_id)
       values ($1, $2, '2026-09-21', $3)`,
      [tee, owner, worn],
    );

    await runMigrations(configOf(database.env), silentLogger);

    const { rows } = await client.query(
      `select id, day::text, outfit_id, worn_at, occasion
       from outfit_calendar order by id`,
    );
    expect(rows).toEqual([
      {
        id: worn,
        day: '2026-09-21',
        outfit_id: day,
        worn_at: new Date('2026-09-22T01:00:00Z'),
        occasion: 'all-day',
      },
      {
        id: planned,
        day: '2026-09-21',
        outfit_id: night,
        worn_at: null,
        occasion: 'all-day',
      },
    ]);
    const { rows: wears } = await client.query(
      'select outfit_calendar_id from garment_wear',
    );
    expect(wears).toEqual([{ outfit_calendar_id: worn }]);

    // New entries default to all day too, and the constraint holds.
    await expect(
      client.query(
        `insert into outfit_calendar (day, outfit_id, owner_id, occasion)
         values ('2026-09-22', $1, $2, 'brunch')`,
        [day, owner],
      ),
    ).rejects.toThrow(/outfit_calendar_occasion_check/);
  });
});
