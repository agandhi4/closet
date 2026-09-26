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
import { Client, type QueryResult } from 'pg';
import { vi } from 'vitest';
import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import type { Db } from '../../src/db/client';
import { user } from '../../src/db/schema';
import { createLogger, createLoggerTo } from '../../src/logger';
import { hashPassword } from '../../src/web/auth/passwords';
import { insertUser } from '../../src/web/auth/queries';
import type { Photos } from '../../src/web/files/photos';
import { LogCapture } from '../support/log-capture';
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
  ACCESS_TOKEN_SECRET: 'integration-test-secret-0123456789abcdef',
};

/**
 * Overrides for an app with the PWA on, as production runs: the service
 * worker, the install prompt and Web Push (/push/*). The VAPID pair is a
 * throwaway from `npx web-push generate-vapid-keys`, never used by a
 * deployment; the sender checks it at boot and needs an https: subject,
 * hence SITE_URL.
 */
export const PWA_ENV: Env = {
  PWA_ENABLED: 'true',
  SITE_URL: 'https://closet.test',
  PUBLIC_VAPID_KEY:
    'BIaV1uMypSUEcMFNiKX5wdEPfTc7liQhw-iTn3WN5TjIc-A0CiCF8jqaef8Vo1jB89cMgxM-FR7ghq0EVO2HlhE',
  PRIVATE_VAPID_KEY: 'xznGX5XpEHzBpfVxnrNyUPBjBbQwl4gtu8inPxMNQws',
};

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
  /** The user registered at boot, whose session t.inject() sends by default. */
  owner: TestUser;
  inject: (options: TestInjectOptions) => Promise<LightMyRequestResponse>;
  /** The app's Drizzle instance (no identity map: reads see every commit). */
  db: Db;
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
  const logs = new LogCapture();
  const logger = options.appLog
    ? createLogger(config)
    : createLoggerTo(config.LOG_LEVEL, logs);

  let app: FastifyInstance;
  let db: Db;
  let photos: Photos;
  try {
    await options.beforeBoot?.(database.env);
    ({ app, db, photos } = await createApp(config, logger));
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
  const sessionFrom = (res: LightMyRequestResponse, action: string) => {
    const token = res.cookies.find((c) => c.name === 'access_token');
    if (!token) {
      throw new Error(
        `${action} did not set access_token (status ${res.statusCode})`,
      );
    }
    return `access_token=${token.value}`;
  };

  const login = async (email: string, password = TEST_PASSWORD) =>
    sessionFrom(
      await inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password },
        headers: uniqueClient(),
        anonymous: true,
      }),
      'login',
    );
  const register = async (email: string, password = TEST_PASSWORD) => {
    if (config.DISABLE_REGISTRATION) {
      await insertUser(db, email, await hashPassword(password));
      return login(email, password);
    }
    return sessionFrom(
      await inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email, password, confirmPassword: password },
        headers: uniqueClient(),
        anonymous: true,
      }),
      'register',
    );
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
    owner,
    inject,
    db,
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

export interface MultipartFile {
  data: Buffer;
  filename: string;
  contentType: string;
}

/**
 * Serialises a multipart/form-data body through the platform FormData so
 * the boundary and part headers are exactly what a browser would send.
 * Spread the result into inject(): `inject({ method: 'POST', url, ...body })`.
 */
export async function multipart(
  fields: Record<string, string>,
  files: Record<string, MultipartFile> = {},
): Promise<{ payload: Buffer; headers: Record<string, string> }> {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    form.append(name, value);
  }
  for (const [name, file] of Object.entries(files)) {
    form.append(
      name,
      // A Uint8Array view: Node's Buffer<ArrayBufferLike> is not a BlobPart
      // in the DOM lib's types (it may sit on a SharedArrayBuffer).
      new Blob([new Uint8Array(file.data)], { type: file.contentType }),
      file.filename,
    );
  }
  const encoded = new Response(form);
  return {
    payload: Buffer.from(await encoded.arrayBuffer()),
    headers: { 'content-type': encoded.headers.get('content-type')! },
  };
}

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

export function hasText(html: string, text: string): boolean {
  return html.includes(text);
}

export interface QueryRecord {
  /** SQL statements sent. */
  statements: number;
  /** Rows they returned, all together. */
  rows: number;
}

type QueryCallback = (error: Error | null, result?: QueryResult) => void;

/**
 * Runs `work` and counts the SQL statements the app sends meanwhile and the
 * rows they return. The app runs in this process and its pool goes through
 * node-postgres's Client class, so wrapping Client.prototype.query sees every
 * statement. For proving a page reads what it shows rather than a
 * whole table: rows, not only statements, since one statement can return
 * everything.
 */
export async function recordQueries(
  work: () => Promise<unknown>,
): Promise<QueryRecord> {
  const record: QueryRecord = { statements: 0, rows: 0 };
  const tally = (result: QueryResult | undefined) => {
    record.rows += result?.rows.length ?? 0;
  };
  // The original, called below with the Client the app called it on.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const query = Client.prototype.query;
  const spy = vi
    .spyOn(Client.prototype, 'query')
    // Client.query is overloaded (promise, callback, Submittable); the
    // wrapper forwards whatever it is given, so it is typed as the original.
    .mockImplementation(function (this: Client, ...args: unknown[]) {
      record.statements += 1;
      const callback = args.at(-1);
      if (typeof callback === 'function') {
        args[args.length - 1] = ((error, result) => {
          tally(result);
          (callback as QueryCallback)(error, result);
        }) satisfies QueryCallback;
      }
      const returned: unknown = Reflect.apply(query, this, args);
      return returned instanceof Promise
        ? returned.then((result: QueryResult) => {
            tally(result);
            return result;
          })
        : returned;
    });
  try {
    await work();
  } finally {
    spy.mockRestore();
  }
  return record;
}
