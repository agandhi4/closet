import { createPhotos, photosConfig } from '../web/files/photos';
import { PhotoStorage } from '../web/files/storage';
import { repairStorageIdentity } from '../web/files/storage-identity';
import { runCli } from './cli';
import { reconcileStorage } from './reconcile';
import { restoreFromTrash } from './trash';

const RESTORE_FLAG = '--restore-from-trash';
const REPAIR_FLAG = '--repair-storage-identity';
const CONFIRM_FLAG = '--confirm';

/**
 * `npm run maintenance:reconcile [-- --dry-run] [-- --force]`: one
 * reconciliation pass against the configured database and storage, then
 * exit: 0 done, 3 the guard refused (see reconcile.ts; `--force` deletes
 * anyway, after a `--dry-run`), 1 failed.
 * `npm run maintenance:reconcile -- --restore-from-trash <name>` instead
 * moves one quarantined photo set back (trash.ts): 0 restored, 3 refused.
 * `npm run maintenance:reconcile -- --repair-storage-identity --confirm`
 * instead pairs the database with DATA_PATH's marker as it is (#833,
 * repairStorageIdentity): 0 paired, 3 refused, 2 without `--confirm`.
 * Builds its own Photos (a separate process from the server's). Reads
 * dist/, so `npm run build` first when developing.
 */
runCli('Reconciliation', async ({ config, logger, db }) => {
  // Before createPhotos: its claim refuses the very storage being re-paired.
  if (process.argv.includes(REPAIR_FLAG)) {
    if (!process.argv.includes(CONFIRM_FLAG)) {
      process.stderr.write(
        `${REPAIR_FLAG} pairs the database with whatever share DATA_PATH holds now: check it is the right one, then add ${CONFIRM_FLAG}\n`,
      );
      return 2;
    }
    const storage = new PhotoStorage(photosConfig(config).dataPath, logger);
    const repair = await repairStorageIdentity(storage, db, logger);
    process.stdout.write(`${JSON.stringify(repair, null, 2)}\n`);
    if ('refused' in repair) {
      logger.warn(`Storage identity repair refused: ${repair.refused}`);
      return 3;
    }
    return 0;
  }
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
