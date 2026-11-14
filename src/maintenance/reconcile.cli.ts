import { createPhotos, photosConfig } from '../web/files/photos';
import { runCli } from './cli';
import { reconcileStorage } from './reconcile';
import { restoreFromTrash } from './trash';

const RESTORE_FLAG = '--restore-from-trash';

/**
 * `npm run maintenance:reconcile [-- --dry-run] [-- --force]`: one
 * reconciliation pass against the configured database and storage, then
 * exit: 0 done, 3 the guard refused (see reconcile.ts; `--force` deletes
 * anyway, after a `--dry-run`), 1 failed.
 * `npm run maintenance:reconcile -- --restore-from-trash <name>` instead
 * moves one quarantined photo set back (trash.ts): 0 restored, 3 refused.
 * Builds its own Photos (a separate process from the server's). Reads
 * dist/, so `npm run build` first when developing.
 */
runCli('Reconciliation', async ({ config, logger, db }) => {
  const photos = await createPhotos(
    photosConfig(config),
    db,
    logger.child({ logger: 'Photos' }),
  );
  const restoreAt = process.argv.indexOf(RESTORE_FLAG);
  if (restoreAt !== -1) {
    const name = process.argv[restoreAt + 1];
    if (!name) throw new Error(`${RESTORE_FLAG} needs a photo set's name`);
    const outcome = await restoreFromTrash(photos.storage, name, logger);
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
    if ('refused' in outcome) {
      logger.warn(`Restore from the trash refused: ${outcome.refused}`);
      return 3;
    }
    return 0;
  }
  const report = await reconcileStorage(
    { db, photos, logger, timeZone: config.APP_TIMEZONE },
    {
      dryRun: process.argv.includes('--dry-run'),
      force: process.argv.includes('--force'),
    },
  );
  // The command's result, for a person or jq to read (not a log line: the
  // summary line goes to the app log too).
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.refused ? 3 : 0;
});
