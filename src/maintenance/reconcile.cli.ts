import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from '../app.module';
import { StorageReconciliationService } from './storage-reconciliation.service';

/**
 * `npm run maintenance:reconcile [-- --dry-run]`: one reconciliation pass
 * against the configured database and storage, then exit. Boots the module
 * graph without an HTTP server, so it runs from the production image
 * (`docker exec closet npm run maintenance:reconcile`) with the container's
 * own environment. Reads dist/, so `npm run build` first when developing.
 *
 * The nightly cron is registered during this boot as well; app.close()
 * stops it before the process exits.
 */
async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  try {
    const report = await app
      .get(StorageReconciliationService)
      .reconcile({ dryRun });
    // The result channel of the CLI; the summary line goes to the app log too.
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
