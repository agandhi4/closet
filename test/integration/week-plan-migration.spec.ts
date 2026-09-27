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
 * The weekly auto-plan's migration (drizzle/NNNN_week_plan.sql) on a
 * database the previous build migrated: #34a's style_rhythm (occasion
 * counts) becomes the week template (weekdays), the one model of the week;
 * every calendar entry becomes the person's (planned_by 'user'); the new
 * constraints hold.
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

/** A copy of drizzle/ that stops before the week plan migration. */
async function migrationsBeforeWeekPlan(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'closet-drizzle-'));
  await mkdir(join(dir, 'meta'));
  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { tag: string }[] };
  const index = journal.entries.findIndex((e) => e.tag.endsWith('_week_plan'));
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

async function userWithRhythm(
  email: string,
  rhythm: [occasion: string, times: number, per: 'week' | 'month'][],
): Promise<number> {
  const id = await insert(
    `insert into "user" (email, password) values ($1, 'x')`,
    [email],
  );
  await client.query(`insert into style_profile (user_id) values ($1)`, [id]);
  for (const [occasion, times, per] of rhythm) {
    await client.query(
      `insert into style_rhythm (user_id, occasion, times, per) values ($1, $2, $3, $4)`,
      [id, occasion, times, per],
    );
  }
  return id;
}

async function templateOf(userId: number): Promise<string[]> {
  const { rows } = await client.query<{ weekday: number; occasion: string }>(
    `select weekday, occasion from week_template where user_id = $1 order by weekday, occasion`,
    [userId],
  );
  return rows.map((row) => `${row.weekday} ${row.occasion}`);
}

beforeEach(async () => {
  database = await createScratchDatabase('closet_it');
  client = new Client(connectionOptions(configOf(database.env)));
  await client.connect();
  folder = await migrationsBeforeWeekPlan();
  await migrate(drizzle(client), { migrationsFolder: folder });
});

afterEach(async () => {
  await client?.end();
  await database?.drop();
  if (folder) await rm(folder, { recursive: true, force: true });
});

describe('the week template replaces the rhythm (the week_plan migration)', () => {
  it("spreads Theo's weekly counts onto weekdays, one outfit for the day each, and drops the monthly ones", async () => {
    const theo = await userWithRhythm('demo@closet.invalid', [
      ['work', 3, 'week'],
      ['all-day', 4, 'week'],
      ['workout', 3, 'week'],
      ['evening', 3, 'month'],
      ['night-out', 1, 'month'],
    ]);
    const busy = await userWithRhythm('busy@example.com', [
      ['work', 5, 'week'],
      ['all-day', 5, 'week'],
      ['evening', 9, 'week'],
    ]);

    await runMigrations(configOf(database.env), silentLogger);

    // Work from Monday on, all day from the weekend back, workouts spread.
    expect(await templateOf(theo)).toEqual([
      '0 all-day',
      '1 work',
      '1 workout',
      '2 work',
      '3 work',
      '4 all-day',
      '4 workout',
      '5 all-day',
      '6 all-day',
      '6 workout',
    ]);
    // Seven days hold at most seven outfits for the day; an evening a day
    // at most.
    expect(await templateOf(busy)).toEqual([
      '0 all-day',
      '0 evening',
      '1 evening',
      '1 work',
      '2 evening',
      '2 work',
      '3 evening',
      '3 work',
      '4 evening',
      '4 work',
      '5 evening',
      '5 work',
      '6 all-day',
      '6 evening',
    ]);
    const { rows } = await client.query(
      `select 1 from information_schema.tables where table_name = 'style_rhythm'`,
    );
    expect(rows).toEqual([]);
  });

  it("makes every calendar entry the person's, and holds the new rules", async () => {
    const owner = await userWithRhythm('owner@example.com', []);
    const outfit = await insert(
      `insert into outfit (shareable_id, owner_id) values (gen_random_uuid()::text, $1)`,
      [owner],
    );
    await client.query(
      `insert into outfit_calendar (day, outfit_id, owner_id) values ('2026-10-01', $1, $2)`,
      [outfit, owner],
    );

    await runMigrations(configOf(database.env), silentLogger);

    const { rows } = await client.query<{ planned_by: string }>(
      `select planned_by from outfit_calendar`,
    );
    expect(rows).toEqual([{ planned_by: 'user' }]);
    await expect(
      client.query(`update outfit_calendar set planned_by = 'robot'`),
    ).rejects.toThrow(/outfit_calendar_planned_by_check/);
    await client.query(
      `insert into week_template (user_id, weekday, occasion) values ($1, 1, 'work'), ($1, 1, 'workout')`,
      [owner],
    );
    await expect(
      client.query(
        `insert into week_template (user_id, weekday, occasion) values ($1, 1, 'all-day')`,
        [owner],
      ),
    ).rejects.toThrow(/week_template_user_id_weekday_day_unique/);
    await expect(
      client.query(
        `insert into week_template (user_id, weekday, occasion) values ($1, 7, 'evening')`,
        [owner],
      ),
    ).rejects.toThrow(/week_template_weekday_check/);
  });
});
