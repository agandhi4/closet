import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectionOptions, type DbConfig } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { migrateBefore } from '../support/migrate-before';
import {
  createScratchDatabase,
  type ScratchDatabase,
} from '../support/scratch-database';
import { silentLogger } from './logger';

/**
 * The wears migration (drizzle/NNNN_wears_washes.sql) on a database that
 * already has calendar entries marked worn, as production (the owner's and
 * the seeded demo's) does: each worn entry gets one wear row per garment of
 * its outfit (the slots as they are, the only record), of the entry's
 * owner, on its day; unworn entries get none; every garment starts as one
 * copy in good shape, never washed, in the closet.
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

beforeAll(async () => {
  database = await createScratchDatabase('closet_it');
  client = new Client(connectionOptions(configOf(database.env)));
  await client.connect();
  await migrateBefore(client, 'wears_washes');
});

afterAll(async () => {
  await client?.end();
  await database?.drop();
});

describe('wears and washes (the wears_washes migration)', () => {
  it('backfills the wears of entries already marked worn, and nothing else', async () => {
    const insert = async (text: string, values: unknown[]) =>
      (await client.query<{ id: number }>(`${text} returning id`, values))
        .rows[0].id;
    const owner = await insert(
      `insert into "user" (email, password) values ('owner@example.com', 'x')`,
      [],
    );
    const other = await insert(
      `insert into "user" (email, password) values ('other@example.com', 'x')`,
      [],
    );
    const garment = (ownerId: number, name: string) =>
      insert(
        `insert into garment (shareable_id, name, category, owner_id)
         values (gen_random_uuid()::text, $1, 'tops', $2)`,
        [name, ownerId],
      );
    const tee = await garment(owner, 'Tee');
    const jeans = await garment(owner, 'Jeans');
    const foreign = await garment(other, 'Not the owner’s');
    const outfit = await insert(
      `insert into outfit (shareable_id, name, owner_id)
       values (gen_random_uuid()::text, 'Look', $1)`,
      [owner],
    );
    // The tee twice, an empty slot, and (as no app write would allow) a
    // garment of another user.
    for (const [position, garmentId] of [
      [0, tee],
      [1, tee],
      [2, jeans],
      [3, null],
      [4, foreign],
    ] as const) {
      await client.query(
        `insert into outfit_slot (outfit_id, position, category, garment_id)
         values ($1, $2, 'tops', $3)`,
        [outfit, position, garmentId],
      );
    }
    const worn = await insert(
      `insert into outfit_calendar (day, outfit_id, owner_id, worn_at)
       values ('2026-09-21', $1, $2, '2026-09-22T01:00:00Z')`,
      [outfit, owner],
    );
    await insert(
      `insert into outfit_calendar (day, outfit_id, owner_id)
       values ('2026-09-22', $1, $2)`,
      [outfit, owner],
    );

    await runMigrations(configOf(database.env), silentLogger);

    const { rows: wears } = await client.query(
      `select garment_id, owner_id, day::text, outfit_calendar_id, created_at
       from garment_wear order by garment_id`,
    );
    expect(wears).toEqual([
      {
        garment_id: tee,
        owner_id: owner,
        day: '2026-09-21',
        outfit_calendar_id: worn,
        created_at: new Date('2026-09-22T01:00:00Z'),
      },
      {
        garment_id: jeans,
        owner_id: owner,
        day: '2026-09-21',
        outfit_calendar_id: worn,
        created_at: new Date('2026-09-22T01:00:00Z'),
      },
    ]);

    const { rows: garments } = await client.query(
      `select quantity, wash_after_wears, last_washed_on, away, away_note,
              condition, condition_note
       from garment where id = $1`,
      [tee],
    );
    expect(garments).toEqual([
      {
        quantity: 1,
        wash_after_wears: null,
        last_washed_on: null,
        away: null,
        away_note: null,
        condition: 'good',
        condition_note: null,
      },
    ]);
  });
});
