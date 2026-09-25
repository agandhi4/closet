import { Options } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';

// `npx mikro-orm migration:create --config mikro-orm.postgres.cli-config.ts`
// diffs the entities against the committed snapshot and a real database: by
// default closet_db on pgvault-dev (localhost:5432, trust auth); the
// DATABASE_* env vars point it elsewhere. The app never reads this file (see
// dal.module.ts).
export default {
  driver: PostgreSqlDriver,
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number(process.env.DATABASE_PORT ?? 5432),
  user: process.env.DATABASE_USER ?? 'postgres',
  password: process.env.DATABASE_PASS,
  dbName: process.env.DATABASE_SCHEMA ?? 'closet_db',
  entities: ['src/dal/entity/**/*.*.*'],
  migrations: {
    path: 'src/dal/migrations/postgres',
    pattern: /^[\w-]+\d+|\d\.ts$/,
    transactional: true,
    // Per-migration transactions; see dal.module.ts.
    allOrNothing: false,
    // Fixed name: by default the snapshot is named after dbName, so pointing
    // the CLI at another database wrote a stray .snapshot-<db>.json.
    snapshotName: '.snapshot-postgres',
  },
  debug: true,
} as Options;
