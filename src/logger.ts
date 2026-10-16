import { join } from 'node:path';
import pino, {
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from 'pino';
import { DEV_RELEASE, loadBuildInfo } from './build-info';
import { bootAppVersion, type Config } from './config';
import { operationFields } from './request-context';

/**
 * The process's one pino logger. Modules take a child named after
 * themselves (`logger.child({ logger: 'Photos' })`), and every line carries
 * that `logger` (observability.md's field name): app.log and the container
 * log are filtered by it. Nothing writes to the console: ESLint's
 * `no-console` holds src/ to this logger.
 */
export type { Logger } from 'pino';

// The session cookie is a bearer credential: a logged header is a stolen
// login for a year. app.log lives under DATA_PATH and the container logs
// reach Loki, so neither may ever hold one. No line logs headers today; this
// is the net under any that would (`logger.info({ req }, ...)`).
const REDACTED_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
];

export type LogLevel = Config['LOG_LEVEL'];

/**
 * Every line's fields: `ts` (RFC 3339 UTC), `level`, `version` (the build's
 * release), the module's `logger`, and the operation it was written for
 * (async context, src/request-context.ts), whichever module's logger writes
 * it: `request_id` while a request runs, `job_id` (and `parent_request_id`)
 * while a job does. A field the line passes itself wins over the mixin's.
 */
function options(level: LogLevel, version: string): LoggerOptions {
  return {
    level,
    base: { version },
    timestamp: () => `,"ts":"${new Date().toISOString()}"`,
    // A new object every call: pino merges the line's fields into it.
    mixin: operationFields,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
  };
}

/**
 * JSON lines name their level (`"level":"info"`), so a query reads them
 * without pino's numbers. Only on a main-thread destination: a worker
 * transport with several targets filters each line by its numeric level and
 * silently drops every line written with the label.
 */
function jsonOptions(level: LogLevel, version: string): LoggerOptions {
  return {
    ...options(level, version),
    formatters: { level: (label) => ({ level: label }) },
  };
}

/**
 * The server's and the CLIs' logger. LOG_LEVEL decides what reaches both
 * outputs, stdout and DATA_PATH/app.log; LOG_FORMAT decides their shape.
 * `json` (the default, and production's): one object per line, which Docker
 * hands to Loki whole, written synchronously so a fatal line before
 * process.exit is never lost. `text`: pino-pretty in a worker thread (which
 * flushes on exit), for a terminal (`npm run start:dev`).
 */
export function createLogger(
  config: Pick<
    Config,
    'LOG_LEVEL' | 'LOG_FORMAT' | 'DATA_PATH' | 'APP_VERSION'
  >,
): Logger {
  const level = config.LOG_LEVEL;
  const version = loadBuildInfo(config.APP_VERSION).release;
  const file = join(config.DATA_PATH, 'app.log');
  if (config.LOG_FORMAT === 'json') {
    return pino(
      jsonOptions(level, version),
      pino.multistream([
        { level, stream: pino.destination({ dest: 1, sync: true }) },
        {
          level,
          stream: pino.destination({ dest: file, mkdir: true, sync: true }),
        },
      ]),
    );
  }
  return pino(
    options(level, version),
    pino.transport({
      targets: [1, file].map((destination) => ({
        target: 'pino-pretty',
        level,
        options: { ...PRETTY, destination, mkdir: destination !== 1 },
      })),
    }),
  );
}

const PRETTY = {
  singleLine: true,
  colorize: true,
  levelFirst: false,
  translateTime: 'yyyy-mm-dd HH:MM:ss',
  timestampKey: 'ts',
  // The release is the same on every line; the boot log names it.
  ignore: 'pid,hostname,version',
};

/**
 * The logger for what happens before the configuration is loaded, or when
 * loading it failed (main.ts, the CLIs): JSON on stdout at info, named
 * `Boot`, with the image's APP_VERSION. Not app.log: DATA_PATH is part of
 * the configuration it may lack. Synchronous, so a fatal line before
 * process.exit is never lost.
 */
export function createBootLogger(): Logger {
  const version = loadBuildInfo(bootAppVersion()).release;
  return pino(
    jsonOptions('info', version),
    pino.destination({ dest: 1, sync: true }),
  ).child({ logger: 'Boot' });
}

/**
 * The same logger, JSON lines to one stream: the tests record them
 * (test/support/log-capture.ts). `version` is the release the lines name.
 */
export function createLoggerTo(
  level: LogLevel,
  destination: DestinationStream,
  version = DEV_RELEASE,
): Logger {
  return pino(jsonOptions(level, version), destination);
}
