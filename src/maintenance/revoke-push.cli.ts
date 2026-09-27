import { runCli } from './cli';
import { runRevokeAllPush } from './revoke-push';

/**
 * `npm run push:revoke-all`: removes every push subscription, after an
 * ACCESS_TOKEN_SECRET rotation (on linux-box: `docker exec closet npm run
 * push:revoke-all`, once the server runs with the new secret). Exit status 0
 * done, 2 usage. Reads dist/, so `npm run build` first when developing.
 */
runCli('RevokePush', ({ db, logger }) =>
  runRevokeAllPush({
    args: process.argv.slice(2),
    db,
    output: process.stdout,
    errors: process.stderr,
    logger,
  }),
);
