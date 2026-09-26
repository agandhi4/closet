import { DrizzleQueryError } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { join } from 'node:path';
import { Client } from 'pg';
import { PROJECT_ROOT } from '../project-root';
import { connectionOptions, type DbConfig, type DbLogger } from './client';

/**
 * Brings the database to the schema in drizzle/ at boot, before anything
 * queries it. The only migration authority: MikroORM's migrator no longer
 * runs (its tree, test/support/legacy-migrations/, is frozen history).
 *
 * - A database built by the legacy MikroORM migrations (it has
 *   `mikro_orm_migrations`, as production does) must have applied the last of
 *   them, LAST_LEGACY_MIGRATION, or the boot is refused. Such a database
 *   already has the baseline's schema, so the baseline (drizzle/0000_*) is
 *   recorded in Drizzle's table exactly as drizzle's migrator would record it,
 *   without running its SQL.
 * - A fresh database runs the baseline like any other migration.
 * - Then drizzle's migrate() applies whatever is newer than the last row.
 *
 * Every step runs on one dedicated connection holding a Postgres advisory
 * lock, so the server and the reconcile CLI (both boot the app) never
 * migrate the same database at once: the second waits, then finds nothing to
 * do.
 */

export const MIGRATIONS_FOLDER = join(PROJECT_ROOT, 'drizzle');

/**
 * The newest file in test/support/legacy-migrations/. A database whose
 * `mikro_orm_migrations` lacks it was left behind by an older build and does
 * not match the baseline. test/integration/migration-runner.spec.ts checks
 * this against the folder.
 */
export const LAST_LEGACY_MIGRATION = 'Migration20260926021506';

// drizzle-orm's defaults (pg-core dialect.migrate); drizzle-kit reads the
// same ones. Changing them would orphan every recorded migration.
const DRIZZLE_SCHEMA = 'drizzle';
const DRIZZLE_TABLE = '__drizzle_migrations';
const DRIZZLE_TABLE_REF = `"${DRIZZLE_SCHEMA}"."${DRIZZLE_TABLE}"`;

// Advisory locks are per database, so this only serializes processes that
// migrate the same one.
export const MIGRATION_LOCK_KEY = 'closet:migrations';

/**
 * A migration statement failed; the batch rolled back. The message is the
 * database's reason (a guard's RAISE EXCEPTION, a violated constraint), which
 * drizzle keeps only as the cause of an error whose own message is the whole
 * failed statement.
 */
export class MigrationFailedError extends Error {
  constructor(cause: Error) {
    super(
      `A Drizzle migration failed and nothing was applied: ${cause.message}`,
      {
        cause,
      },
    );
    this.name = 'MigrationFailedError';
  }
}

export class LegacyMigrationsIncompleteError extends Error {
  constructor() {
    super(
      `This database was built by the legacy MikroORM migrations but has not applied ` +
        `${LAST_LEGACY_MIGRATION}, the last of them, so it does not match the Drizzle baseline. ` +
        `Boot a build from before the switch to Drizzle once (it applies the remaining MikroORM ` +
        `migrations), then this one.`,
    );
    this.name = 'LegacyMigrationsIncompleteError';
  }
}

export async function runMigrations(
  config: DbConfig,
  logger: DbLogger,
): Promise<void> {
  const started = Date.now();
  const client = new Client(connectionOptions(config));
  await client.connect();
  try {
    await acquireLock(client, logger);
    if (await isLegacyDatabase(client)) {
      await requireLastLegacyMigration(client);
      await recordBaseline(client, logger);
    }
    const before = await appliedCount(client);
    try {
      await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
    } catch (error) {
      if (error instanceof DrizzleQueryError && error.cause instanceof Error) {
        throw new MigrationFailedError(error.cause);
      }
      throw error;
    }
    const applied = (await appliedCount(client)) - before;
    logger.info(
      applied === 0
        ? `Schema up to date (${before} Drizzle migrations recorded)`
        : `Applied ${applied} Drizzle migration(s) in ${Date.now() - started} ms`,
    );
  } finally {
    // Ending the session releases the advisory lock, whether or not a step
    // failed (an explicit unlock on a broken connection would only mask the
    // original error).
    await client.end();
  }
}

async function acquireLock(client: Client, logger: DbLogger): Promise<void> {
  const { rows } = await client.query<{ locked: boolean }>(
    'select pg_try_advisory_lock(hashtext($1)) as locked',
    [MIGRATION_LOCK_KEY],
  );
  if (rows[0].locked) return;
  logger.info('Another process is migrating this database; waiting for it');
  await client.query('select pg_advisory_lock(hashtext($1))', [
    MIGRATION_LOCK_KEY,
  ]);
}

async function isLegacyDatabase(client: Client): Promise<boolean> {
  const { rows } = await client.query<{ legacy: boolean }>(
    `select to_regclass('mikro_orm_migrations') is not null as legacy`,
  );
  return rows[0].legacy;
}

async function requireLastLegacyMigration(client: Client): Promise<void> {
  // MikroORM strips a .js/.ts extension when it compares names, and very old
  // builds recorded one; accept either form as it does.
  const { rowCount } = await client.query(
    'select 1 from mikro_orm_migrations where name = any($1::text[])',
    [['', '.js', '.ts'].map((ext) => `${LAST_LEGACY_MIGRATION}${ext}`)],
  );
  if (!rowCount) throw new LegacyMigrationsIncompleteError();
}

/**
 * Inserts the baseline's row as drizzle's migrator would after running it:
 * readMigrationFiles() is the migrator's own reader, so hash (sha256 of the
 * SQL file) and created_at (the journal's `when`) are exactly its values.
 * The table DDL is copied from drizzle-orm's pg-core dialect; migrate()
 * repeats it with IF NOT EXISTS.
 */
async function recordBaseline(client: Client, logger: DbLogger): Promise<void> {
  const [baseline] = readMigrationFiles({
    migrationsFolder: MIGRATIONS_FOLDER,
  });
  await client.query('begin');
  try {
    await client.query(`create schema if not exists "${DRIZZLE_SCHEMA}"`);
    await client.query(
      `create table if not exists ${DRIZZLE_TABLE_REF} (id serial primary key, hash text not null, created_at bigint)`,
    );
    const { rowCount } = await client.query(
      `select 1 from ${DRIZZLE_TABLE_REF} where created_at = $1`,
      [baseline.folderMillis],
    );
    if (rowCount) {
      await client.query('commit');
      return;
    }
    await client.query(
      `insert into ${DRIZZLE_TABLE_REF} (hash, created_at) values ($1, $2)`,
      [baseline.hash, baseline.folderMillis],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
  logger.info(
    `Legacy MikroORM database (through ${LAST_LEGACY_MIGRATION}): recorded the Drizzle baseline as applied without running it`,
  );
}

// Two queries: a statement naming a missing table fails at parse time, even
// in a branch that would not run.
async function appliedCount(client: Client): Promise<number> {
  const exists = await client.query<{ exists: boolean }>(
    'select to_regclass($1) is not null as exists',
    [DRIZZLE_TABLE_REF],
  );
  if (!exists.rows[0].exists) return 0;
  const { rows } = await client.query<{ count: number }>(
    `select count(*)::int as count from ${DRIZZLE_TABLE_REF}`,
  );
  return rows[0].count;
}
