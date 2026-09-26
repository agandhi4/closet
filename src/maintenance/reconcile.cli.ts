import { createPhotos, photosConfig } from '../web/files/photos';
import { runCli } from './cli';
import { reconcileStorage } from './reconcile';

/**
 * `npm run maintenance:reconcile [-- --dry-run] [-- --force]`: one
 * reconciliation pass against the configured database and storage, then
 * exit: 0 done, 3 the guard refused (see reconcile.ts; `--force` deletes
 * anyway, after a `--dry-run`), 1 failed. Builds its own Photos (a separate
 * process from the server's). Reads dist/, so `npm run build` first when
 * developing.
 */
runCli('Reconciliation', async ({ config, logger, db }) => {
  const report = await reconcileStorage(
    {
      db,
      photos: createPhotos(
        photosConfig(config),
        db,
        logger.child({ context: 'Photos' }),
      ),
      logger,
    },
    {
      dryRun: process.argv.includes('--dry-run'),
      force: process.argv.includes('--force'),
    },
  );
  // The result channel of the CLI; the summary line goes to the app log too.
  console.log(JSON.stringify(report, null, 2));
  return report.refused ? 3 : 0;
});
