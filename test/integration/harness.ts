import { eq } from 'drizzle-orm';
import type {
  FastifyInstance,
  InjectOptions,
  LightMyRequestResponse,
} from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import type { OutgoingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { type AppOptions, createApp } from '../../src/app';
import { type Config, loadConfig } from '../../src/config';
import type { CutoutQueue } from '../../src/cutout/queue';
import { type Db, dbConfig, type DbConfig } from '../../src/db/client';
import { user } from '../../src/db/schema';
import { createLogger, createLoggerTo, type Logger } from '../../src/logger';
import { hashPassword } from '../../src/web/auth/passwords';
import { insertUser } from '../../src/web/auth/queries';
import { type IsoDate, todayIn } from '../../src/web/calendar/calendar-date';
import type { Photos } from '../../src/web/files/photos';
import type { PushSender } from '../../src/web/push/sender';
import type { WeatherService } from '../../src/web/weather/service';
import type { Metrics } from '../../src/metrics/metrics';
import type { OrderMailDeps } from '../../src/web/wardrobe/order-mail/poll';
import { LogCapture } from '../support/log-capture';
import { recordStatements } from '../support/query-recorder';
import { createScratchDatabase } from '../support/scratch-database';

/**
 * Boots the real application in-process (createApp + ready(), no listen)
 * against a private database and a fresh temp DATA_PATH, and exposes
 * inject() plus the database (t.db, Drizzle) and what the app logged
 * (t.logs) so specs can assert on HTML, headers, rows, files and log lines
 * together. The app's configuration is BASE_ENV plus the overrides, through
 * the real loadConfig() but without the process environment or the .env
 * files, so a developer's .env.local never leaks into a spec.
 *
 * Every spec file gets its own scratch Postgres database (see
 * test/support/scratch-database.ts), dropped again by cleanup().
 *
 * Login is always required, so every app starts with a signed-in default
 * user, `t.owner`, and t.inject() sends the owner's session cookie unless the
 * request carries its own `cookie` header or asks for `anonymous: true`.
 * Specs that are not about accounts or sharing never think about sessions.
 *
 * Every state-changing request must name this site in Origin (the CSRF
 * check, src/web/security/same-origin.ts), which inject() never does on its
 * own: t.inject() adds `Origin: http://localhost` (the origin inject's
 * requests are addressed to) unless the request sets Origin or Referer
 * itself or asks for `sameOrigin: false`.
 *
 * Login and registration are rate limited per client address, and inject()
 * always comes from 127.0.0.1: t.register() and t.login() each send their
 * own X-Forwarded-For (127.0.0.1 is a trusted proxy here), so no spec runs
 * into the limit by signing people up. Specs about the limit pick their own.
 */

export type Env = Record<string, string>;

const BASE_ENV: Env = {
  NODE_ENV: 'test',
  // Everything down to debug reaches t.logs (nothing reaches the console).
  LOG_LEVEL: 'debug',
  APP_NAME: 'Closet',
  SITE_URL: 'http://localhost:3000',
  TRUSTED_PROXIES: '127.0.0.1,::1',
  DISABLE_REGISTRATION: 'false',
  PWA_ENABLED: 'false',
  // No spec reaches Open-Meteo: weather is off unless a spec turns it on
  // with the stand-in (test/support/weather-stub.ts), which createTestApp
  // then requires.
  WEATHER_ENABLED: 'false',
  ACCESS_TOKEN_SECRET: 'integration-test-secret-0123456789abcdef',
};

export { PWA_ENV } from '../support/pwa-env';

export const TEST_PASSWORD = 'Password123!';
export const OWNER_EMAIL = 'owner@example.com';
/** The origin inject()'s requests are addressed to (Host: localhost:80). */
export const APP_ORIGIN = 'http://localhost';

export type TestInjectOptions = InjectOptions & {
  /** Send no session cookie at all (the owner's is otherwise the default). */
  anonymous?: boolean;
  /**
   * false: send no Origin on a state-changing request (the CSRF specs). By
   * default one naming this site is added unless Origin or Referer is set.
   */
  sameOrigin?: boolean;
};

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function hasHeader(headers: OutgoingHttpHeaders, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

/** A state-changing request that says nothing about where it comes from. */
function needsOrigin(
  method: string | undefined,
  headers: OutgoingHttpHeaders,
): boolean {
  return (
    UNSAFE_METHODS.has((method ?? 'GET').toUpperCase()) &&
    !hasHeader(headers, 'origin') &&
    !hasHeader(headers, 'referer')
  );
}

let clientSeq = 0;
/** A client address of its own, for a request that counts against a rate limit. */
export function uniqueClient(): { 'x-forwarded-for': string } {
  clientSeq += 1;
  return {
    'x-forwarded-for': `198.18.${Math.floor(clientSeq / 250)}.${(clientSeq % 250) + 1}`,
  };
}

export interface TestUser {
  id: number;
  email: string;
  /** `access_token=...`, ready for a `cookie` header. */
  cookie: string;
}

export interface TestApp {
  app: FastifyInstance;
  /** Uploads, thumbs and app.log land here; removed by cleanup(). */
  dataPath: string;
  /** The app's one Photos (what the routes store and serve through). */
  photos: Photos;
  /**
   * The background-removal queue, not running: a spec starts it with a
   * fake runner (test/integration/cutouts.ts); cleanup() stops it.
   */
  cutouts: CutoutQueue;
  /**
   * The app's Web Push sender (PWA_ENV only): what the reminders send
   * through when a spec runs them (sendDueReminders); nothing schedules
   * them in the harness.
   */
  push: PushSender | undefined;
  /**
   * The app's weather service (WEATHER_ENABLED only). A spec that counts
   * fetches or reads the row after a stale ask awaits `settled()`: the
   * answer is served before its background refresh ends (#114).
   */
  weather: WeatherService | undefined;
  /** The app's metrics (what GET /metrics exposes with METRICS_ENABLED). */
  metrics: Metrics;
  /**
   * The order mail's poll (ORDER_MAIL_JMAP_TOKEN and the JMAP stub only):
   * a spec runs it with pollOrderMail; nothing schedules it here.
   */
  orderMail: OrderMailDeps | undefined;
  /** The user registered at boot, whose session t.inject() sends by default. */
  owner: TestUser;
  inject: (options: TestInjectOptions) => Promise<LightMyRequestResponse>;
  /** The app's Drizzle instance (no identity map: reads see every commit). */
  db: Db;
  /**
   * Where the app's database is (dbConfig): for a spec that connects as
   * another process would (createDb, a pg Client).
   */
  database: DbConfig;
  /** The app's root logger, for modules a spec builds itself (into t.logs). */
  logger: Logger;
  /** The app's APP_TIMEZONE. */
  timeZone: string;
  /**
   * The app's "today": todayIn() in its APP_TIMEZONE, as every route asks,
   * read at the call so a faked Date moves it. The one way a spec names
   * today: a UTC date (toISOString) is tomorrow every evening in New York.
   */
  today: () => IsoDate;
  /**
   * Every line the app logged at LOG_LEVEL and above, parsed; empty when the
   * app writes the real app.log instead (TestAppOptions.appLog).
   */
  logs: LogCapture;
  /**
   * POST /auth/register (a seeded row plus a login when DISABLE_REGISTRATION
   * is on); returns the session cookie for later requests.
   */
  register: (email: string, password?: string) => Promise<string>;
  /** POST /auth/login; returns the session cookie for later requests. */
  login: (email: string, password?: string) => Promise<string>;
  cleanup: () => Promise<void>;
}

export interface TestAppOptions {
  /**
   * Runs against the scratch database before the app boots (and migrates
   * it), e.g. to build it with the legacy MikroORM migrations. Receives the
   * DATABASE_* values.
   */
  beforeBoot?: (databaseEnv: Env) => Promise<void>;
  /**
   * Log as the server does, to stdout and DATA_PATH/app.log (pino-pretty in
   * a worker thread), instead of into t.logs.
   */
  appLog?: boolean;
  /**
   * The outbound fetcher's test-only options (AppOptions.outboundFetch): a
   * scripted resolver and a loopback alias standing in for the internet
   * (test/integration/link-sites.ts, which serves it).
   */
  outboundFetch?: AppOptions['outboundFetch'];
  /**
   * Open-Meteo's stand-in (startWeatherStub().options, test/support/
   * weather-stub.ts): required with WEATHER_ENABLED=true.
   */
  weather?: AppOptions['weather'];
  /**
   * Fastmail's stand-in (startJmapStub().options, test/support/
   * jmap-stub.ts): required with ORDER_MAIL_JMAP_TOKEN.
   */
  orderMail?: AppOptions['orderMail'];
}

/** A spec never reaches a real third party: each one it turns on needs its stand-in. */
function missingStandIn(
  config: Config,
  options: TestAppOptions,
): string | undefined {
  if (config.WEATHER_ENABLED && !options.weather) {
    return 'WEATHER_ENABLED=true needs the weather stub (options.weather): a spec must never call Open-Meteo';
  }
  if (config.ORDER_MAIL_JMAP_TOKEN && !options.orderMail) {
    return 'ORDER_MAIL_JMAP_TOKEN needs the JMAP stub (options.orderMail): a spec must never call Fastmail';
  }
  return undefined;
}

export async function createTestApp(
  overrides: Partial<Env> = {},
  options: TestAppOptions = {},
) {
  const dataPath = await mkdtemp(join(tmpdir(), 'closet-int-'));
  const database = await createScratchDatabase('closet_it');
  const config = loadConfig({
    env: { ...BASE_ENV, ...database.env, DATA_PATH: dataPath, ...overrides },
    envFiles: [],
  });
  const missing = missingStandIn(config, options);
  if (missing) {
    await database.drop();
    await rm(dataPath, { recursive: true, force: true });
    throw new Error(missing);
  }
  const logs = new LogCapture();
  const logger = options.appLog
    ? createLogger(config)
    : createLoggerTo(config.LOG_LEVEL, logs);

  let app: FastifyInstance;
  let db: Db;
  let photos: Photos;
  let cutouts: CutoutQueue;
  let push: PushSender | undefined;
  let weather: WeatherService | undefined;
  let metrics: Metrics;
  let orderMail: OrderMailDeps | undefined;
  try {
    await options.beforeBoot?.(database.env);
    ({ app, db, photos, cutouts, push, weather, metrics, orderMail } =
      await createApp(config, logger, {
        outboundFetch: options.outboundFetch,
        weather: options.weather,
        orderMail: options.orderMail,
      }));
    await app.ready();
  } catch (error) {
    // A failing boot (typically a migration) must not leak the database.
    await database.drop();
    await rm(dataPath, { recursive: true, force: true });
    throw error;
  }

  let owner: TestUser | undefined;
  const inject = ({
    anonymous = false,
    sameOrigin = true,
    ...options
  }: TestInjectOptions) => {
    const headers: OutgoingHttpHeaders = { ...options.headers };
    if (!anonymous && !hasHeader(headers, 'cookie') && owner) {
      headers.cookie = owner.cookie;
    }
    if (sameOrigin && needsOrigin(options.method, headers)) {
      headers.origin = APP_ORIGIN;
    }
    return app.inject({ ...options, headers });
  };
  // A sign-in that set no session names what the app logged at warn and
  // above while it ran: a setup 500 otherwise says only its status, and the
  // cause sits in t.logs, which no spec prints once createTestApp throws
  // (#249).
  const signIn = async (action: string, request: TestInjectOptions) => {
    const mark = logs.records.length;
    const res = await inject({
      method: 'POST',
      headers: uniqueClient(),
      anonymous: true,
      ...request,
    });
    const token = res.cookies.find((c) => c.name === 'access_token');
    if (!token) {
      const serverSide = options.appLog
        ? 'the app logged to stdout and app.log (appLog)'
        : logs.describeFrom(mark, 'warn');
      throw new Error(
        `${action} did not set access_token (status ${res.statusCode}); ${serverSide}`,
      );
    }
    return `access_token=${token.value}`;
  };

  const login = (email: string, password = TEST_PASSWORD) =>
    signIn('login', { url: '/auth/login', payload: { email, password } });
  const register = async (email: string, password = TEST_PASSWORD) => {
    if (config.DISABLE_REGISTRATION) {
      await insertUser(db, email, await hashPassword(password));
      return login(email, password);
    }
    return signIn('register', {
      url: '/auth/register',
      payload: { email, password, confirmPassword: password },
    });
  };

  try {
    const cookie = await register(OWNER_EMAIL);
    const [row] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, OWNER_EMAIL));
    owner = { id: row.id, email: OWNER_EMAIL, cookie };
  } catch (error) {
    await app.close();
    await database.drop();
    await rm(dataPath, { recursive: true, force: true });
    throw error;
  }

  return {
    app,
    dataPath,
    photos,
    cutouts,
    push,
    weather,
    metrics,
    orderMail,
    owner,
    inject,
    db,
    database: dbConfig(config),
    logger,
    timeZone: config.APP_TIMEZONE,
    today: () => todayIn(config.APP_TIMEZONE, new Date()),
    logs,
    register,
    login,
    cleanup: async () => {
      await app.close();
      await database.drop();
      await rm(dataPath, { recursive: true, force: true });
    },
  } satisfies TestApp;
}

/** The id of the account registered with `email`. */
export async function userIdOf(t: TestApp, email: string): Promise<number> {
  const [row] = await t.db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email));
  if (!row) throw new Error(`No account for ${email}`);
  return row.id;
}

export { multipart, type MultipartFile } from '../support/multipart';

/** Full `<img ...>` tags in document order. */
export function imgTags(html: string): string[] {
  return html.match(/<img\b[^>]*>/g) ?? [];
}

export function extractImgSrcs(html: string): string[] {
  return imgTags(html)
    .map((tag) => /\ssrc="([^"]*)"/.exec(tag)?.[1])
    .filter((src): src is string => src !== undefined);
}

/**
 * Undoes the escaping JSX views apply to text and attribute values (the set
 * src/web/html.ts escapeHtml writes), so a spec can match an attribute such
 * as `href="/calendar?week=...&calMonth=..."` as the browser reads it.
 */
export function unescapeHtml(html: string): string {
  return html
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

/**
 * The path an htmx write navigates to (`navigateTo`, src/web/render.ts):
 * asserts the answer is an HX-Location that swaps the body as a boosted page
 * (no HX-Redirect, which reloads the document) and returns its path.
 */
export function hxLocationPath(res: LightMyRequestResponse): string {
  expect(res.headers['hx-redirect']).toBeUndefined();
  const location = JSON.parse(String(res.headers['hx-location'])) as {
    path: string;
  };
  expect(location).toMatchObject({
    target: 'body',
    headers: { 'HX-Boosted': 'true' },
  });
  return location.path;
}

export function hasText(html: string, text: string): boolean {
  return html.includes(text);
}

export interface QueryRecord {
  /** SQL statements sent. */
  statements: number;
  /** Rows they returned, all together. */
  rows: number;
  /** Each statement's SQL text, in order. */
  sql: string[];
}

/**
 * Runs `work` and counts the SQL statements the app sends meanwhile and the
 * rows they return (recordStatements, test/support/query-recorder.ts). For
 * proving a page reads what it shows rather than a whole table: rows, not
 * only statements, since one statement can return everything.
 */
export async function recordQueries(
  work: () => Promise<unknown>,
): Promise<QueryRecord> {
  const { statements } = await recordStatements(work);
  return {
    statements: statements.length,
    rows: statements.reduce((sum, statement) => sum + statement.rows, 0),
    sql: statements.map((statement) => statement.sql),
  };
}
