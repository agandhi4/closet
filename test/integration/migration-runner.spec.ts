import { readMigrationFiles } from 'drizzle-orm/migrator';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connectionOptions,
  createDb,
  type DbConfig,
  type DbLogger,
} from '../../src/db/client';
import {
  LAST_LEGACY_MIGRATION,
  LegacyMigrationsIncompleteError,
  MIGRATION_LOCK_KEY,
  MIGRATIONS_FOLDER,
  runMigrations,
} from '../../src/db/migrate';
import {
  applyLegacyMigrations,
  legacyMigrationNames,
} from '../support/legacy-migrations';
import { schemaDrift } from '../support/schema-drift';
import {
  createScratchDatabase,
  type ScratchDatabase,
} from '../support/scratch-database';
import { createTestApp, TestApp } from './harness';

/**
 * src/db/migrate.ts on the three kinds of database it meets: one built by the
 * legacy MikroORM migrations (production's), one that stopped short of them,
 * and a fresh one; plus two runners racing on the same database. The app
 * boots once, on the legacy database (one app per spec file); the other
 * cases call the runner directly, which is all the boot does with it.
 */

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

function recordingLogger(): DbLogger & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    info: (message) => messages.push(message),
    error: (message) => messages.push(message),
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

const drizzleRows = (env: Record<string, string>) =>
  withClient(env, async (client) => {
    const { rows } = await client.query<{ hash: string; created_at: string }>(
      'select hash, created_at from drizzle.__drizzle_migrations order by id',
    );
    return rows.map((row) => ({
      hash: row.hash,
      createdAt: Number(row.created_at),
    }));
  });

const tableExists = (env: Record<string, string>, name: string) =>
  withClient(env, async (client) => {
    const { rows } = await client.query<{ exists: boolean }>(
      'select to_regclass($1) is not null as exists',
      [name],
    );
    return rows[0].exists;
  });

const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
const [baseline] = migrations;
/** Every migration in drizzle/, as drizzle records them once applied. */
const allRecorded = migrations.map((migration) => ({
  hash: migration.hash,
  createdAt: migration.folderMillis,
}));

it('knows the newest legacy migration', () => {
  expect(legacyMigrationNames().at(-1)).toBe(LAST_LEGACY_MIGRATION);
});

describe('a database built by the legacy MikroORM migrations', () => {
  let t: TestApp;
  let databaseEnv: Record<string, string>;

  beforeAll(async () => {
    t = await createTestApp(
      {},
      {
        beforeBoot: async (env) => {
          databaseEnv = env;
          await applyLegacyMigrations(env);
          // Production has rows; the boot must leave them alone.
          await withClient(env, (client) =>
            client.query(
              `insert into "user" (shareable_id, email, password) values ('legacy-share-id', 'legacy@example.com', 'x')`,
            ),
          );
        },
      },
    );
  });

  afterAll(() => t?.cleanup());

  it('records the baseline exactly as drizzle would, without running it, then applies the rest', async () => {
    // Running it would have failed the boot: its CREATE TABLEs exist.
    expect(await drizzleRows(databaseEnv)).toEqual(allRecorded);
    expect(allRecorded[0]).toEqual({
      hash: baseline.hash,
      createdAt: baseline.folderMillis,
    });
    expect(await tableExists(databaseEnv, 'mikro_orm_migrations')).toBe(true);
  });

  it('matches src/db/schema.ts', async () => {
    expect(await schemaDrift(t.db)).toEqual([]);
  });

  it('keeps the existing rows and serves requests', async () => {
    const legacy = await t.db.query.user.findFirst({
      where: (user, { eq }) => eq(user.email, 'legacy@example.com'),
    });
    expect(legacy?.password).toBe('x');
    const res = await t.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(204);
  });

  it('does nothing on the next boot', async () => {
    const logger = recordingLogger();
    await runMigrations(configOf(databaseEnv), logger);
    expect(await drizzleRows(databaseEnv)).toEqual(allRecorded);
    expect(logger.messages).toEqual([
      `Schema up to date (${migrations.length} Drizzle migrations recorded)`,
    ]);
  });
});

describe('a legacy database without the last MikroORM migration', () => {
  let database: ScratchDatabase;

  beforeAll(async () => {
    database = await createScratchDatabase('closet_it');
    const names = legacyMigrationNames();
    await applyLegacyMigrations(database.env, { to: names.at(-2) });
  });

  afterAll(() => database?.drop());

  it('refuses to migrate, naming the missing migration', async () => {
    const run = runMigrations(configOf(database.env), recordingLogger());
    await expect(run).rejects.toBeInstanceOf(LegacyMigrationsIncompleteError);
    await expect(run).rejects.toThrow(LAST_LEGACY_MIGRATION);
    expect(
      await tableExists(database.env, 'drizzle.__drizzle_migrations'),
    ).toBe(false);
  });
});

describe('a fresh database', () => {
  let database: ScratchDatabase;

  beforeAll(async () => {
    database = await createScratchDatabase('closet_it');
  });

  afterAll(() => database?.drop());

  it('runs the baseline and every later migration', async () => {
    const logger = recordingLogger();
    await runMigrations(configOf(database.env), logger);
    expect(await drizzleRows(database.env)).toEqual(allRecorded);
    expect(logger.messages).toEqual([
      expect.stringMatching(
        new RegExp(
          `^Applied ${migrations.length} Drizzle migration\\(s\\) in \\d+ ms$`,
        ),
      ),
    ]);
    const db = createDb(configOf(database.env), recordingLogger());
    try {
      expect(await schemaDrift(db)).toEqual([]);
    } finally {
      await db.$client.end();
    }
  });
});

describe('two runners on one fresh database', () => {
  let database: ScratchDatabase;

  beforeAll(async () => {
    database = await createScratchDatabase('closet_it');
  });

  afterAll(() => database?.drop());

  // Without the lock both would read an empty history and run the baseline;
  // the second would fail on tables the first created.
  it('migrate one after the other', async () => {
    const first = recordingLogger();
    const second = recordingLogger();
    // Hold the lock so both runners are provably waiting on it, then let go.
    await withClient(database.env, async (holder) => {
      await holder.query('select pg_advisory_lock(hashtext($1))', [
        MIGRATION_LOCK_KEY,
      ]);
      const runs = Promise.all([
        runMigrations(configOf(database.env), first),
        runMigrations(configOf(database.env), second),
      ]);
      await expect
        .poll(() => [...first.messages, ...second.messages])
        .toEqual([
          'Another process is migrating this database; waiting for it',
          'Another process is migrating this database; waiting for it',
        ]);
      await holder.query('select pg_advisory_unlock(hashtext($1))', [
        MIGRATION_LOCK_KEY,
      ]);
      await runs;
    });
    expect(await drizzleRows(database.env)).toEqual(allRecorded);
    const outcomes = [first.messages.at(-1), second.messages.at(-1)].sort();
    expect(outcomes).toEqual([
      expect.stringMatching(
        new RegExp(`^Applied ${migrations.length} Drizzle migration\\(s\\)`),
      ),
      `Schema up to date (${migrations.length} Drizzle migrations recorded)`,
    ]);
  });
});
