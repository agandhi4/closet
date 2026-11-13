import { pushSchema } from 'drizzle-kit/api';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Db } from '../../src/db/client';
import * as schema from '../../src/db/schema';
import { hidePrototypeExtensions } from './prototype-hygiene';

// drizzle-kit/api assigns helpers onto Array.prototype (`random`) and
// String.prototype (`camelCase`, `trimChar`, ...) when it is evaluated, as
// plain enumerable properties. This module is its only importer, and runs
// right after it: pushSchema keeps calling them, no `for...in` in the shared
// worker sees them (#620; shared-worker-setup.ts fails a file that leaves one).
hidePrototypeExtensions();

/**
 * The statements `drizzle-kit push` would run to make the database match
 * src/db/schema.ts: empty when the migrations in drizzle/ build exactly the
 * declared schema. A schema edit without its generated migration boots fine
 * and fails later in production (garment.color became a smallint that way),
 * so the integration tier asserts this after every kind of boot.
 *
 * mikro_orm_migrations stays in legacy databases and is not part of the
 * schema (the same filter as drizzle.config.ts). The filter covers tables
 * only: drizzle-kit introspects the table's serial sequence as a standalone
 * sequence and would drop it, so that one statement is not drift.
 */
const LEGACY_STATEMENTS = new Set([
  'DROP SEQUENCE "public"."mikro_orm_migrations_id_seq";',
]);

export async function schemaDrift(db: Db): Promise<string[]> {
  // pushSchema takes a schema-less instance; this one shares the app's pool.
  const { statementsToExecute } = await pushSchema(
    schema,
    drizzle(db.$client),
    ['public'],
    ['!mikro_orm_migrations'],
  );
  return statementsToExecute.filter(
    (statement) => !LEGACY_STATEMENTS.has(statement),
  );
}
