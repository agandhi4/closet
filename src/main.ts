import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createApp } from './app';
import type { Db } from './db/client';
import { DB } from './db/db.module';
import { scheduleNightly } from './maintenance/nightly';
import { reconcileStorage } from './maintenance/reconcile';

// The hour, in APP_TIMEZONE, of the nightly storage reconciliation.
const RECONCILE_HOUR = 3;

async function bootstrap() {
  const { app, photos } = await createApp();
  const config = app.get(ConfigService);
  const logger = new Logger('Reconciliation');
  // The server is the only process that schedules it: the integration
  // harness and the CLIs build the same app without this.
  if (config.getOrThrow<boolean>('MAINTENANCE_ENABLED')) {
    const deps = {
      db: app.get<Db>(DB),
      photos,
      logger,
    };
    const nightly = scheduleNightly({
      name: 'Storage reconciliation',
      hour: RECONCILE_HOUR,
      timeZone: config.getOrThrow<string>('APP_TIMEZONE'),
      run: () => reconcileStorage(deps),
      logger,
    });
    // Before listen(): Fastify takes no hooks once it is ready.
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('onClose', (_instance, done) => {
        nightly.stop();
        done();
      });
  } else {
    logger.log('Storage reconciliation disabled (MAINTENANCE_ENABLED=false)');
  }
  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}
// eslint-disable-next-line @typescript-eslint/no-floating-promises
bootstrap();
