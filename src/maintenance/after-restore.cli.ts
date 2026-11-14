import { createPhotos, photosConfig } from '../web/files/photos';
import { afterRestore } from './after-restore';
import { runCli } from './cli';

/**
 * `npm run maintenance:after-restore`: the post-restore command
 * (after-restore.ts), then exit: 0 done, 3 when reconciliation's dry run
 * refused (the share is not the household's: the report says why; the epoch
 * and the revocation happened all the same), 2 usage, 1 failed. In
 * production: docker exec closet npm run maintenance:after-restore. Reads
 * dist/, so `npm run build` first when developing.
 */
runCli('AfterRestore', async ({ config, logger, db }) => {
  if (process.argv.length > 2) {
    process.stderr.write('Usage: npm run maintenance:after-restore\n');
    return 2;
  }
  const report = await afterRestore({
    db,
    photos: await createPhotos(
      photosConfig(config),
      db,
      logger.child({ logger: 'Photos' }),
    ),
    logger,
    timeZone: config.APP_TIMEZONE,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.reconciliation.refused ? 3 : 0;
});
