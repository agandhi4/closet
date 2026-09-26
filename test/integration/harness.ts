import { EntityManager, MikroORM } from '@mikro-orm/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import type { OutgoingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { User } from '../../src/dal/entity/user.entity';
import { createScratchDatabase } from '../support/scratch-database';

/**
 * Boots the real application in-process (createApp + app.init(), no listen)
 * against a private database and a fresh temp DATA_PATH, and exposes
 * app.inject() plus the ORM so specs can assert on HTML, headers, rows and
 * files together. One app per spec file: AppModule reads process.env at
 * import time, so the env cannot change after the first boot in a worker.
 *
 * Every spec file gets its own scratch Postgres database (see
 * test/support/scratch-database.ts), dropped again by cleanup().
 *
 * Login is always required, so every app starts with a signed-in default
 * user, `t.owner`, and t.inject() sends the owner's session cookie unless the
 * request carries its own `cookie` header or asks for `anonymous: true`.
 * Specs that are not about accounts or sharing never think about sessions.
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

export type TestInjectOptions = InjectOptions & {
  /** Send no session cookie at all (the owner's is otherwise the default). */
  anonymous?: boolean;
};

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
  /** A fresh identity map per call, so reads see what the app flushed. */
  em: () => EntityManager;
  /** POST /auth/register; returns the session cookie for later requests. */
  register: (email: string, password?: string) => Promise<string>;
  /** POST /auth/login; returns the session cookie for later requests. */
  login: (email: string, password?: string) => Promise<string>;
  cleanup: () => Promise<void>;
}

export async function createTestApp(overrides: Partial<Env> = {}) {
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
  const inject = ({ anonymous = false, ...options }: TestInjectOptions) => {
    const headers: OutgoingHttpHeaders = { ...options.headers };
    const ownCookie = Object.keys(headers).some(
      (name) => name.toLowerCase() === 'cookie',
    );
    if (!anonymous && !ownCookie && owner) headers.cookie = owner.cookie;
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

  const register = async (email: string, password = TEST_PASSWORD) =>
    sessionFrom(
      await inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email, password, confirmPassword: password },
        anonymous: true,
      }),
      'register',
    );

  try {
    const cookie = await register(OWNER_EMAIL);
    const user = await orm.em
      .fork()
      .findOneOrFail(User, { email: OWNER_EMAIL });
    owner = { id: user.id, email: OWNER_EMAIL, cookie };
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
    em: () => orm.em.fork(),
    register,
    login: async (email: string, password = TEST_PASSWORD) =>
      sessionFrom(
        await inject({
          method: 'POST',
          url: '/auth/login',
          payload: { email, password },
          anonymous: true,
        }),
        'login',
      ),
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

export function hasText(html: string, text: string): boolean {
  return html.includes(text);
}
