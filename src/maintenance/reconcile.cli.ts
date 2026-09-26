import { NestFactory } from '@nestjs/core';
import { Logger as NestLogger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { photosConfig } from '../app';
import { AppModule } from '../app.module';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import { createPhotos } from '../web/files/photos';
import { reconcileStorage } from './reconcile';

/**
 * `npm run maintenance:reconcile [-- --dry-run] [-- --force]`: one
 * reconciliation pass against the configured database and storage, then
 * exit. `--force` deletes even when the guard refuses (see reconcile.ts);
 * look at a `--dry-run` first. Boots the module graph without an HTTP
 * server (for its config and database) and builds its own Photos (a
 * separate process from the server's), so it runs from the
 * production image (`docker exec closet npm run maintenance:reconcile`) with
 * the container's own environment. Reads dist/, so `npm run build` first
 * when developing.
 */
async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const force = process.argv.includes('--force');
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  // bufferLogs only flushes on listen(), which a CLI never calls.
  app.flushLogs();
  try {
    const db = app.get<Db>(DB);
    const report = await reconcileStorage(
      {
        db,
        photos: createPhotos(
          photosConfig(app.get(ConfigService)),
          db,
          new NestLogger('Photos'),
        ),
        logger: new NestLogger('Reconciliation'),
      },
      { dryRun, force },
    );
    // The result channel of the CLI; the summary line goes to the app log too.
    console.log(JSON.stringify(report, null, 2));
    if (report.refused) process.exitCode = 3;
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
