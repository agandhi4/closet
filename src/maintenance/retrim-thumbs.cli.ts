import { createPhotos, photosConfig } from '../web/files/photos';
import { runCli } from './cli';
import { retrimCutoutThumbs } from './retrim-thumbs';

/**
 * `npm run maintenance:retrim-thumbs [-- --dry-run]`: gives every photo
 * with a cutout the thumb trimmed to its garment (#373; retrim-thumbs.ts),
 * then exits: 0 done, 1 when any photo failed (logged by id; run it again)
 * or the run itself did. Run once after the deploy that trims new thumbs;
 * a second run changes nothing. Builds its own Photos (a separate process
 * from the server's). Reads dist/, so `npm run build` first when developing.
 */
runCli('ThumbRetrim', async ({ config, logger, db }) => {
  const report = await retrimCutoutThumbs(
    {
      db,
      photos: createPhotos(
        photosConfig(config),
        db,
        logger.child({ logger: 'Photos' }),
      ),
      logger,
    },
    { dryRun: process.argv.includes('--dry-run') },
  );
  // The command's result, for a person or jq to read (the summary line goes
  // to the app log too).
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.failed > 0 ? 1 : 0;
});
