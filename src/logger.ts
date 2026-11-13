import pino, {
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from 'pino';
import { DEV_RELEASE, loadBuildInfo } from './build-info';
import { bootAppVersion, type Config } from './config';
import { operationFields } from './request-context';
import { scrubSecrets } from './secret-text';

/**
 * The process's one pino logger. Modules take a child named after
 * themselves (`logger.child({ logger: 'Photos' })`), and every line carries
 * that `logger` (observability.md's field name): the container log is
 * filtered by it. Nothing writes to the console: ESLint's
 * `no-console` holds src/ to this logger.
 */
export type { Logger } from 'pino';

// The session cookie is a bearer credential: a logged header is a stolen
// login for a year. The container logs reach Loki and a LOG_FILE may hold a
// copy, so neither may ever hold one. No line logs headers today; this
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
    serializers: { err: errorFields },
  };
}

// Error text is foreign input: a fetch, sharp or driver error (or its cause) can quote an
// upstream URL with its token, a connection string, a query string or a slice of a response.
// So no logger call splices String(err), err.message or err.stack into a line (guards.conf
// no-raw-error-text); it passes `{ err }` and errorFields writes it. Unlike rollcall's helper
// the stack stays, redacted like the message: a 500 is logged with it (errors.spec.tsx).
const MESSAGE_MAX = 200;
// file:// is left alone: it is a stack frame's location, never an upstream's address.
const URL_PATTERN = /\b(?!file:)[a-z][a-z0-9+.-]*:\/\/\S+/gi;
// A query string or key=value pair outside a URL: `?api_key=…`, `&token=…`.
const PARAM_PATTERN = /[?&]?\b[\w.-]+=[^\s&]+/g;

// After scrubSecrets (src/secret-text.ts, applied per message in errorFields): a Drizzle params
// tail goes whole before PARAM_PATTERN would cut it into pieces.
function redact(text: string): string {
  return text.replace(URL_PATTERN, '<url>').replace(PARAM_PATTERN, '<param>');
}

export interface ErrorFields {
  type: string;
  message?: string;
  stack?: string;
  code?: string;
  status?: number;
}

/**
 * The `err` serializer of every closet logger (Fastify's too: it takes the
 * instance as given). Like pino's own serializer it appends the causes to
 * the message (`: `) and the stack (`caused by: `), since a driver error's
 * reason is often only its cause; of the rest only the class, `code` and an
 * HTTP status are kept: pino's copy of every own field would log a client's
 * request options or a query's params whole. A thrown non-Error is logged
 * by its type alone.
 */
export function errorFields(err: unknown): ErrorFields {
  if (!(err instanceof Error)) return { type: typeof err };
  const chain = causeChain(err);
  const fields: ErrorFields = {
    type: err.constructor.name,
    message: truncate(
      redact(chain.map((e) => scrubSecrets(e.message)).join(': ')),
    ),
    stack: redact(chain.map(scrubbedStack).join('\ncaused by: ')),
  };
  // `statusCode`: HttpError's and web-push's WebPushError's name for it.
  const { code, status, statusCode } = err as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
  };
  if (typeof code === 'string') fields.code = code;
  const httpStatus = typeof status === 'number' ? status : statusCode;
  if (typeof httpStatus === 'number') fields.status = httpStatus;
  return fields;
}

// The error and its causes, outermost first; a cycle ends the walk.
function causeChain(err: Error): Error[] {
  const chain: Error[] = [];
  for (
    let e: unknown = err;
    e instanceof Error && !chain.includes(e);
    e = e.cause
  ) {
    chain.push(e);
  }
  return chain;
}

// Gotcha: a Drizzle params tail runs to the end of its message, but in a stack the frames
// follow it, and a user's value can itself look like a frame. So the stack's copy of the
// message is swapped for the scrubbed message by position, never found by its contents. A
// stack that does not quote its message is scrubbed whole, which drops everything after a
// `params:` line: losing frames beats logging the values.
function scrubbedStack(e: Error): string {
  const stack = e.stack ?? '';
  const at = stack.indexOf(e.message);
  if (e.message === '' || at < 0) return scrubSecrets(stack);
  const rest = stack.slice(at + e.message.length);
  return stack.slice(0, at) + scrubSecrets(e.message) + scrubSecrets(rest);
}

function truncate(text: string): string {
  return text.length > MESSAGE_MAX ? `${text.slice(0, MESSAGE_MAX)}…` : text;
}

/**
 * JSON lines name their level (`"level":"info"`), so a query reads them
 * without pino's numbers (pino-pretty reads the name as well).
 */
function jsonOptions(level: LogLevel, version: string): LoggerOptions {
  return {
    ...options(level, version),
    formatters: { level: (label) => ({ level: label }) },
  };
}

/**
 * The server's and the CLIs' logger. Stdout is the one sink: the container
 * log Docker hands to Loki. LOG_LEVEL decides what reaches it; LOG_FORMAT
 * its shape. `json` (the default, and production's): one object per line,
 * written synchronously so a fatal line before process.exit is never lost.
 * `text`: pino-pretty in a worker thread (which flushes on exit), for a
 * terminal (`npm run start:dev`).
 *
 * LOG_FILE adds JSON lines to a file for hand debugging, whatever LOG_FORMAT.
 * `stdout` is the console's destination, a parameter for the unit spec.
 */
export function createLogger(
  config: Pick<Config, 'LOG_LEVEL' | 'LOG_FORMAT' | 'LOG_FILE' | 'APP_VERSION'>,
  stdout: DestinationStream = consoleDestination(config.LOG_FORMAT),
): Logger {
  const level = config.LOG_LEVEL;
  const version = loadBuildInfo(config.APP_VERSION).release;
  if (!config.LOG_FILE) return pino(jsonOptions(level, version), stdout);
  return pino(
    jsonOptions(level, version),
    pino.multistream([
      { level, stream: stdout },
      { level, stream: fileSink(config.LOG_FILE, stdout, level, version) },
    ]),
  );
}

function consoleDestination(format: Config['LOG_FORMAT']): DestinationStream {
  return format === 'json'
    ? pino.destination({ dest: 1, sync: true })
    : pino.transport({
        target: 'pino-pretty',
        options: { ...PRETTY, destination: 1 },
      });
}

/**
 * The opt-in file is written asynchronously: a stalled disk or share costs
 * buffered lines, never the event loop (a synchronous log file on NFS froze
 * the whole app, #632). An open or write error is an `error` event, which
 * unhandled ends the process; it is reported to stdout once and the file
 * stops (a destination that failed to open throws on its next write), while
 * the console keeps every line. Lines still buffered at a crash are lost.
 */
function fileSink(
  file: string,
  stdout: DestinationStream,
  level: LogLevel,
  version: string,
): DestinationStream {
  const sink = pino.destination({ dest: file, sync: false });
  let failed = false;
  sink.on('error', (err: unknown) => {
    if (failed) return;
    failed = true;
    pino(jsonOptions(level, version), stdout)
      .child({ logger: 'Logger' })
      .error({ err, file }, 'LOG_FILE is not writable; its lines are dropped');
  });
  return {
    write: (line) => {
      if (!failed) sink.write(line);
    },
  };
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
 * `Boot`, with the image's APP_VERSION. Never LOG_FILE: it is part of
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
