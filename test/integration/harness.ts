import { EntityManager, MikroORM } from '@mikro-orm/core';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import type { OutgoingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../../src/db/client';
import { DB } from '../../src/db/db.module';
import { user } from '../../src/db/schema';
import { hashPassword } from '../../src/web/auth/passwords';
import { insertUser } from '../../src/web/auth/queries';
import { createScratchDatabase } from '../support/scratch-database';

/**
 * Boots the real application in-process (createApp + app.init(), no listen)
 * against a private database and a fresh temp DATA_PATH, and exposes
 * app.inject() plus the database (t.db, Drizzle; t.em(), MikroORM) so specs
 * can assert on HTML, headers, rows and files together. New row assertions
 * use t.db: MikroORM goes away as features are ported. One app per spec file: AppModule reads process.env at
 * import time, so the env cannot change after the first boot in a worker.
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
  LOG_LEVEL: 'silent',
  APP_NAME: 'Closet',
  SITE_URL: 'http://localhost:3000',
  TRUSTED_PROXIES: '127.0.0.1,::1',
  DISABLE_REGISTRATION: 'false',
  PWA_ENABLED: 'false',
  ACCESS_TOKEN_SECRET: 'integration-test-secret',
  FILE_STORAGE_TYPE: 'local',
  // No nightly cron timer in a test process; reconcile.spec.ts calls
  // StorageReconciliationService.reconcile() directly.
  MAINTENANCE_ENABLED: 'false',
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
  app: NestFastifyApplication;
  /** Uploads, thumbs and app.log land here; removed by cleanup(). */
  dataPath: string;
  /** The user registered at boot, whose session t.inject() sends by default. */
  owner: TestUser;
  inject: (options: TestInjectOptions) => Promise<LightMyRequestResponse>;
  /** The app's Drizzle instance (no identity map: reads see every commit). */
  db: Db;
  /** A fresh identity map per call, so reads see what the app flushed. */
  em: () => EntityManager;
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
}

export async function createTestApp(
  overrides: Partial<Env> = {},
  options: TestAppOptions = {},
) {
  const dataPath = await mkdtemp(join(tmpdir(), 'closet-int-'));
  const database = await createScratchDatabase('closet_it');
  Object.assign(
    process.env,
    BASE_ENV,
    database.env,
    { DATA_PATH: dataPath },
    overrides,
  );

  // Deferred on purpose: ConfigModule.forRoot validates process.env when
  // app.module is first evaluated, so the module graph must not load before
  // the env above is in place.
  const { createApp } = await import('../../src/app');
  let app: NestFastifyApplication;
  try {
    await options.beforeBoot?.(database.env);
    app = await createApp();
    await app.init();
  } catch (error) {
    // A failing boot (typically a migration) must not leak the database.
    await database.drop();
    await rm(dataPath, { recursive: true, force: true });
    throw error;
  }

  const orm = app.get(MikroORM);
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

  const db = app.get<Db>(DB);
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
  const registrationDisabled = process.env.DISABLE_REGISTRATION === 'true';
  const register = async (email: string, password = TEST_PASSWORD) => {
    if (registrationDisabled) {
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
    owner,
    inject,
    db,
    em: () => orm.em.fork(),
    register,
    login,
    cleanup: async () => {
      await app.close();
      await database.drop();
      await rm(dataPath, { recursive: true, force: true });
    },
  } satisfies TestApp;
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
