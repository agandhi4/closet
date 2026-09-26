import { join } from 'node:path';
import pino, {
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from 'pino';
import type { Config } from './config';

/**
 * The process's one pino logger. Modules take a child named after
 * themselves (`logger.child({ context: 'Photos' })`), and every line carries
 * that `context`: app.log and the container log are filtered by it.
 */
export type { Logger } from 'pino';

// The session cookie is a bearer credential: a logged header is a stolen
// login for a year. app.log lives under DATA_PATH and the container logs
// reach Loki, so neither may ever hold one. No line logs headers today; this
// is the net under any that would (`logger.info({ req }, ...)`).
export const REDACTED_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
];

export type LogLevel = Config['LOG_LEVEL'];

function options(level: LogLevel): LoggerOptions {
  return {
    level,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
  };
}

/**
 * The server's and the CLIs' logger. LOG_LEVEL decides what reaches both
 * outputs: pretty lines on stdout and the same lines in DATA_PATH/app.log,
 * written by pino-pretty in a worker thread (which flushes on exit).
 */
export function createLogger(
  config: Pick<Config, 'LOG_LEVEL' | 'DATA_PATH'>,
): Logger {
  const pretty = {
    singleLine: true,
    colorize: true,
    levelFirst: false,
    translateTime: 'yyyy-mm-dd HH:MM:ss',
  };
  return pino(
    options(config.LOG_LEVEL),
    pino.transport({
      targets: [
        {
          target: 'pino-pretty',
          level: config.LOG_LEVEL,
          options: { ...pretty, destination: 1 },
        },
        {
          target: 'pino-pretty',
          level: config.LOG_LEVEL,
          options: {
            ...pretty,
            destination: join(config.DATA_PATH, 'app.log'),
            mkdir: true,
          },
        },
      ],
    }),
  );
}

/**
 * The same logger writing JSON lines to one stream: the tests record them
 * (test/support/log-capture.ts).
 */
export function createLoggerTo(
  level: LogLevel,
  destination: DestinationStream,
): Logger {
  return pino(options(level), destination);
}
