import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectionOptions, type DbConfig } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { applyLegacyMigrations } from '../support/legacy-migrations';
import {
  createScratchDatabase,
  type ScratchDatabase,
} from '../support/scratch-database';

/**
 * drizzle/0003_user_device_push.sql on a MikroORM-era database: the keys
 * move out of the subscription JSON into columns, rows that cannot be pushed
 * to are deleted, and the endpoint takes more than 255 characters.
 */

const LOGGER = { info: () => undefined, error: () => undefined };

const P256DH = 'B'.repeat(87);
const AUTH = 'a'.repeat(22);

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
  await applyLegacyMigrations(database.env);
  client = new Client(connectionOptions(configOf(database.env)));
  await client.connect();
});

afterAll(async () => {
  await client?.end();
  await database?.drop();
});

describe('user_device keys become columns (0003_user_device_push)', () => {
  it('keeps pushable rows with their keys and drops the rest', async () => {
    const {
      rows: [owner],
    } = await client.query<{ id: number }>(
      `insert into "user" (shareable_id, email, password)
       values ('owner-share-id', 'owner@example.com', 'x') returning id`,
    );
    const legacy = [
      ['https://push.test/ok', { keys: { p256dh: P256DH, auth: AUTH } }],
      ['https://push.test/no-subscription', null],
      ['https://push.test/no-auth', { keys: { p256dh: P256DH } }],
      ['https://push.test/numeric', { keys: { p256dh: 1, auth: 2 } }],
      ['https://push.test/not-an-object', 'subscription'],
    ] as const;
    for (const [endpoint, json] of legacy) {
      await client.query(
        `insert into user_device (user_agent, push_endpoint, web_push_subscription, user_id)
         values ('agent', $1, $2::jsonb, $3)`,
        [endpoint, json === null ? null : JSON.stringify(json), owner.id],
      );
    }

    await runMigrations(configOf(database.env), LOGGER);

    const { rows } = await client.query(
      `select push_endpoint, key_p256dh, key_auth, user_agent, user_id,
              created_at is not null and updated_at is not null as stamped
         from user_device order by id`,
    );
    expect(rows).toEqual([
      {
        push_endpoint: 'https://push.test/ok',
        key_p256dh: P256DH,
        key_auth: AUTH,
        user_agent: 'agent',
        user_id: owner.id,
        stamped: true,
      },
    ]);

    const { rows: columns } = await client.query<{
      name: string;
      type: string;
      nullable: string;
    }>(
      `select column_name as name, data_type as type, is_nullable as nullable
         from information_schema.columns
        where table_name = 'user_device' order by column_name`,
    );
    expect(columns).toEqual([
      { name: 'created_at', type: 'timestamp with time zone', nullable: 'NO' },
      { name: 'id', type: 'integer', nullable: 'NO' },
      { name: 'key_auth', type: 'text', nullable: 'NO' },
      { name: 'key_p256dh', type: 'text', nullable: 'NO' },
      { name: 'push_endpoint', type: 'text', nullable: 'NO' },
      { name: 'updated_at', type: 'timestamp with time zone', nullable: 'NO' },
      { name: 'user_agent', type: 'text', nullable: 'YES' },
      { name: 'user_id', type: 'integer', nullable: 'NO' },
    ]);
  });
});
