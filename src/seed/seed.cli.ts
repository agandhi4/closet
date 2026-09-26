import { runCli } from '../maintenance/cli';
import { createPhotos, photosConfig } from '../web/files/photos';
import { runSeed } from './seed';

/**
 * `npm run seed -- --persona demo|fresh|sparse|all [--reset | --remove]
 * [--anchor YYYY-MM-DD] [--share-with <email>] [--password-stdin]
 * [--token]`: see
 * src/seed/seed.ts and CLAUDE.md, Seed personas. Like the maintenance CLIs
 * it refuses a database behind the build (start the server first) and
 * builds its own Photos. Exit status 0 done, 1 refused, 2 usage. Reads
 * dist/, so `npm run build` first when developing. On linux-box:
 * `docker exec closet npm run seed -- --persona demo`.
 */
runCli('Seed', ({ config, logger, db }) =>
  runSeed({
    args: process.argv.slice(2),
    db,
    photos: createPhotos(
      photosConfig(config),
      db,
      logger.child({ context: 'Photos' }),
    ),
    logger,
    timeZone: config.APP_TIMEZONE,
    input: process.stdin,
    output: process.stdout,
    errors: process.stderr,
    now: new Date(),
  }),
);
