import { createPhotos, photosConfig } from '../web/files/photos';
import { runCli } from './cli';
import { repointCutout, UNKEYED } from './repoint-cutout';

/**
 * `npm run maintenance:repoint-cutout -- <photo> <key|unkeyed>`: points the
 * photo's row at the nobg and thumb stored under that key (repoint-cutout.ts),
 * then exits: 0 done, 3 refused (no such row or files, an outfit selfie),
 * 2 usage, 1 failed. Never migrates (runCli). Reads dist/, so
 * `npm run build` first when developing.
 */
runCli('CutoutRepoint', async ({ config, logger, db }) => {
  const [photo, key, ...rest] = process.argv.slice(2);
  if (!photo || !key || rest.length > 0) {
    process.stderr.write(
      `Usage: npm run maintenance:repoint-cutout -- <uuid>.webp <variant key|${UNKEYED}>\n`,
    );
    return 2;
  }
  const photos = await createPhotos(
    photosConfig(config),
    db,
    logger.child({ logger: 'Photos' }),
  );
  const outcome = await repointCutout(
    { db, storage: photos.storage, logger },
    photo,
    key,
  );
  process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  return outcome.repointed ? 0 : 3;
});
