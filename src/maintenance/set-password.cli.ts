import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from '../app.module';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import { runSetPassword } from './set-password';

/**
 * `npm run user:set-password -- <email>`: sets a locked-out user's password
 * (on the NAS: `docker exec -it closet npm run user:set-password -- <email>`).
 * The password is read from the terminal without echo, or from piped stdin.
 * Boots the module graph without an HTTP server, like reconcile.cli.ts, so
 * it uses the container's own configuration; reads dist/, so `npm run build`
 * first when developing.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.flushLogs();
  try {
    process.exitCode = await runSetPassword({
      args: process.argv.slice(2),
      db: app.get<Db>(DB),
      input: process.stdin,
      output: process.stdout,
      errors: process.stderr,
      logger: {
        log: (message) => app.get(Logger).log(message, 'SetPassword'),
      },
    });
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
