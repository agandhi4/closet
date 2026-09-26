import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectionOptions, type DbConfig } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { applyLegacyMigrations } from '../support/legacy-migrations';
import {
  createScratchDatabase,
  type ScratchDatabase,
} from '../support/scratch-database';
import { silentLogger } from './logger';

/**
 * drizzle/0006_file_cutout.sql on a database that already holds photos:
 * every existing photo starts with no server cutout asked for (`none`, so
 * nothing is queued by the deploy), and the status column takes only the
 * state machine's statuses (src/cutout/state.ts).
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
  await applyLegacyMigrations(database.env);
  client = new Client(connectionOptions(configOf(database.env)));
  await client.connect();
});

afterAll(async () => {
  await client?.end();
  await database?.drop();
});

describe('file cutout columns (0006_file_cutout)', () => {
  it('leaves existing photos without a server cutout and refuses unknown statuses', async () => {
    const {
      rows: [owner],
    } = await client.query<{ id: number }>(
      `insert into "user" (shareable_id, email, password)
       values ('owner-share-id', 'owner@example.com', 'x') returning id`,
    );
    await client.query(
      `insert into file (shareable_id, file_name, created_on, created_by_id, version)
       values ('photo-share-id', 'a.webp', '2026-09-01T00:00:00.000Z', $1, 4)`,
      [owner.id],
    );

    await runMigrations(configOf(database.env), silentLogger);

    const { rows } = await client.query(
      `select file_name, version, cutout_status, cutout_attempts,
              cutout_job_version, cutout_requested_at from file`,
    );
    expect(rows).toEqual([
      {
        file_name: 'a.webp',
        version: 4,
        cutout_status: 'none',
        cutout_attempts: 0,
        cutout_job_version: null,
        cutout_requested_at: null,
      },
    ]);

    await expect(
      client.query(`update file set cutout_status = 'running'`),
    ).rejects.toThrow(/file_cutout_status_check/);
  });
});
