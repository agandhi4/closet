import { Client } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { connectionOptions, type DbConfig } from '../../src/db/client';
import { MigrationFailedError, runMigrations } from '../../src/db/migrate';
import { applyLegacyMigrations } from '../support/legacy-migrations';
import {
  createScratchDatabase,
  type ScratchDatabase,
} from '../support/scratch-database';

/**
 * drizzle/0001_calendar_day.sql on data shaped like production's: every
 * build before it stored a calendar day as the timestamptz at UTC midnight
 * (new Date('YYYY-MM-DD')). Each case builds a database with the legacy
 * MikroORM migrations, as production's was, adds rows, and runs the boot's
 * migration runner on it.
 */

const LOGGER = { info: () => undefined, error: () => undefined };

let databases: ScratchDatabase[] = [];

afterEach(async () => {
  await Promise.all(databases.map((database) => database.drop()));
  databases = [];
});

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

async function withClient<T>(
  env: Record<string, string>,
  use: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client(connectionOptions(configOf(env)));
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
}

interface LegacyEntry {
  /** A timestamptz literal, as MikroORM stored it. */
  date: string;
  wornAt?: string;
  notes?: string;
  /** Index into the two seeded outfits. */
  outfit?: 0 | 1;
}

/**
 * A MikroORM-era database holding one user, two outfits and the given
 * outfit_calendar rows. Returns its env and the entry ids in order.
 */
async function legacyDatabase(entries: LegacyEntry[]) {
  const database = await createScratchDatabase('closet_it');
  databases.push(database);
  await applyLegacyMigrations(database.env);
  const ids = await withClient(database.env, async (client) => {
    const {
      rows: [owner],
    } = await client.query<{ id: number }>(
      `insert into "user" (shareable_id, email, password)
       values ('owner-share-id', 'owner@example.com', 'x') returning id`,
    );
    const outfits: number[] = [];
    for (const name of ['First', 'Second']) {
      const { rows } = await client.query<{ id: number }>(
        `insert into outfit (shareable_id, name, owner_id)
         values ($1, $2, $3) returning id`,
        [`${name}-share-id`, name, owner.id],
      );
      outfits.push(rows[0].id);
    }
    const inserted: number[] = [];
    for (const entry of entries) {
      const { rows } = await client.query<{ id: number }>(
        `insert into outfit_calendar (date, outfit_id, owner_id, worn_at, notes)
         values ($1, $2, $3, $4, $5) returning id`,
        [
          entry.date,
          outfits[entry.outfit ?? 0],
          owner.id,
          entry.wornAt ?? null,
          entry.notes ?? null,
        ],
      );
      inserted.push(rows[0].id);
    }
    return inserted;
  });
  return { env: database.env, ids };
}

const calendarRows = (env: Record<string, string>) =>
  withClient(env, async (client) => {
    const { rows } = await client.query<{ id: number; day: string }>(
      // to_char: node-postgres would parse a date into a local-time Date.
      `select id, to_char(day, 'YYYY-MM-DD') as day
         from outfit_calendar order by id`,
    );
    return rows;
  });

const columnsOf = (env: Record<string, string>) =>
  withClient(env, async (client) => {
    const { rows } = await client.query<{ name: string; type: string }>(
      `select column_name as name, data_type as type
         from information_schema.columns
        where table_name = 'outfit_calendar' order by column_name`,
    );
    return Object.fromEntries(rows.map((row) => [row.name, row.type]));
  });

describe('calendar days become dates (0001_calendar_day)', () => {
  it('keeps the day of every UTC-midnight value, whatever the session zone', async () => {
    const { env, ids } = await legacyDatabase([
      { date: '2026-09-25T00:00:00Z' },
      // The spring-forward Sunday and a leap day, where a local-time
      // conversion would have slipped.
      { date: '2026-03-08T00:00:00Z' },
      { date: '2028-02-29T00:00:00Z' },
      { date: '2026-12-31T00:00:00Z', wornAt: '2027-01-01T15:00:00Z' },
    ]);
    // The conversion names its zone; a server or session default must not
    // matter.
    await withClient(env, (client) =>
      client.query(
        `alter database "${env.DATABASE_SCHEMA}" set timezone to 'America/New_York'`,
      ),
    );

    await runMigrations(configOf(env), LOGGER);

    expect(await calendarRows(env)).toEqual([
      { id: ids[0], day: '2026-09-25' },
      { id: ids[1], day: '2026-03-08' },
      { id: ids[2], day: '2028-02-29' },
      { id: ids[3], day: '2026-12-31' },
    ]);
    expect(await columnsOf(env)).toEqual({
      day: 'date',
      id: 'integer',
      outfit_id: 'integer',
      owner_id: 'integer',
      worn_at: 'timestamp with time zone',
    });
  });

  it('collapses duplicate schedules to one entry, keeping the worn one', async () => {
    const { env, ids } = await legacyDatabase([
      { date: '2026-10-22T00:00:00Z' },
      { date: '2026-10-22T00:00:00Z', wornAt: '2026-10-22T20:00:00Z' },
      { date: '2026-10-22T00:00:00Z' },
      { date: '2026-10-22T00:00:00Z', outfit: 1 },
      { date: '2026-10-23T00:00:00Z' },
      { date: '2026-10-23T00:00:00Z' },
    ]);

    await runMigrations(configOf(env), LOGGER);

    expect((await calendarRows(env)).map((row) => row.id)).toEqual([
      ids[1],
      ids[3],
      ids[4],
    ]);
  });

  it('aborts on a value that is not UTC midnight, changing nothing', async () => {
    const { env } = await legacyDatabase([
      { date: '2026-09-25T00:00:00Z' },
      { date: '2026-09-25T04:00:00Z' },
    ]);

    const run = runMigrations(configOf(env), LOGGER);
    await expect(run).rejects.toBeInstanceOf(MigrationFailedError);
    await expect(run).rejects.toThrow(
      /1 row\(s\) have a date that is not UTC midnight/,
    );

    // The batch rolled back: still the legacy column, and 0001 unrecorded.
    expect(await columnsOf(env)).toMatchObject({
      date: 'timestamp with time zone',
      notes: 'character varying',
    });
    const recorded = await withClient(env, async (client) => {
      const { rows } = await client.query<{ n: number }>(
        'select count(*)::int as n from drizzle.__drizzle_migrations',
      );
      return rows[0].n;
    });
    expect(recorded).toBe(1);
  });

  it('aborts rather than drop notes someone wrote', async () => {
    const { env } = await legacyDatabase([
      { date: '2026-09-25T00:00:00Z', notes: 'Wedding' },
    ]);

    await expect(runMigrations(configOf(env), LOGGER)).rejects.toThrow(
      /1 row\(s\) have notes/,
    );
    expect(await columnsOf(env)).toMatchObject({ notes: 'character varying' });
  });
});
