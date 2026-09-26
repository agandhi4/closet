import { Client } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { connectionOptions, type DbConfig } from '../../src/db/client';
import { MigrationFailedError, runMigrations } from '../../src/db/migrate';
import { applyLegacyMigrations } from '../support/legacy-migrations';
import {
  createScratchDatabase,
  type ScratchDatabase,
} from '../support/scratch-database';
import { silentLogger } from './logger';

/**
 * drizzle/0005_email_lower_outfit_text.sql on a MikroORM-era database, whose
 * unique constraint was on the raw email: every address is stored as
 * normalizeEmail writes it, a clash once lower-cased aborts the boot, and
 * outfit name and notes become text.
 */

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

/** A legacy database holding these users, and a client on it. */
async function legacyDatabaseWith(emails: (string | null)[]) {
  const database = await createScratchDatabase('closet_it');
  databases.push(database);
  await applyLegacyMigrations(database.env);
  const client = new Client(connectionOptions(configOf(database.env)));
  await client.connect();
  for (const [i, email] of emails.entries()) {
    await client.query(
      `insert into "user" (shareable_id, email, password) values ($1, $2, 'x')`,
      [`user-${i}`, email],
    );
  }
  return { env: database.env, client };
}

describe('emails unique case-insensitively (0005_email_lower_outfit_text)', () => {
  it('stores every address lower case and trimmed, then refuses a second in any case', async () => {
    const { env, client } = await legacyDatabaseWith([
      'Owner@Example.COM',
      ' partner@example.com ',
      'plain@example.com',
      null,
      null,
    ]);
    try {
      await runMigrations(configOf(env), silentLogger);

      const { rows } = await client.query<{ email: string | null }>(
        'select email from "user" order by id',
      );
      expect(rows.map((row) => row.email)).toEqual([
        'owner@example.com',
        'partner@example.com',
        'plain@example.com',
        null,
        null,
      ]);

      await expect(
        client.query(
          `insert into "user" (email, password)
           values ('OWNER@example.com', 'x')`,
        ),
      ).rejects.toMatchObject({
        code: '23505',
        constraint: 'user_lower_email_unique',
      });
    } finally {
      await client.end();
    }
  });

  it('aborts on two accounts that clash once lower-cased, changing nothing', async () => {
    const { env, client } = await legacyDatabaseWith([
      'Twin@example.com',
      'solo@example.com',
      'twin@EXAMPLE.com ',
    ]);
    try {
      const run = runMigrations(configOf(env), silentLogger);
      await expect(run).rejects.toBeInstanceOf(MigrationFailedError);
      await expect(run).rejects.toThrow(
        /accounts share an email once lower-cased \(user ids \d+, \d+\)/,
      );

      const { rows } = await client.query<{ email: string }>(
        'select email from "user" order by id',
      );
      expect(rows.map((row) => row.email)).toEqual([
        'Twin@example.com',
        'solo@example.com',
        'twin@EXAMPLE.com ',
      ]);
      const { rows: applied } = await client.query<{ count: string }>(
        'select count(*) from drizzle.__drizzle_migrations',
      );
      // Only the baseline the runner records for a legacy database.
      expect(Number(applied[0].count)).toBe(1);
    } finally {
      await client.end();
    }
  });

  it('turns outfit name and notes into text, keeping what they held', async () => {
    const { env, client } = await legacyDatabaseWith(['owner@example.com']);
    try {
      await client.query(
        `insert into outfit (shareable_id, name, notes, owner_id)
         select 'outfit-1', 'Office look', 'Ironed', id from "user"`,
      );
      await runMigrations(configOf(env), silentLogger);

      const { rows: columns } = await client.query<{
        name: string;
        type: string;
      }>(
        `select column_name as name, data_type as type
           from information_schema.columns
          where table_name = 'outfit' and column_name in ('name', 'notes')
          order by column_name`,
      );
      expect(columns).toEqual([
        { name: 'name', type: 'text' },
        { name: 'notes', type: 'text' },
      ]);
      const { rows } = await client.query('select name, notes from outfit');
      expect(rows).toEqual([{ name: 'Office look', notes: 'Ironed' }]);
    } finally {
      await client.end();
    }
  });
});
