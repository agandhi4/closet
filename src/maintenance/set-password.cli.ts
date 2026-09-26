import { runCli } from './cli';
import { runSetPassword } from './set-password';

/**
 * `npm run user:set-password -- <email>`: sets a locked-out user's password
 * (on the NAS: `docker exec -it closet npm run user:set-password -- <email>`).
 * The password is read from the terminal without echo, or from piped stdin.
 * Exit status 0 set, 1 refused, 2 usage. Reads dist/, so `npm run build`
 * first when developing.
 */
runCli('SetPassword', ({ db, logger }) =>
  runSetPassword({
    args: process.argv.slice(2),
    db,
    input: process.stdin,
    output: process.stdout,
    errors: process.stderr,
    logger,
  }),
);
