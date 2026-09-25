import { EntityManager, MikroORM } from '@mikro-orm/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Boots the real application in-process (createApp + app.init(), no listen)
 * against a private in-memory SQLite and a fresh temp DATA_PATH, and exposes
 * app.inject() plus the ORM so specs can assert on HTML, headers, rows and
 * files together. One app per spec file: AppModule reads process.env at
 * import time, so the env cannot change after the first boot in a worker.
 */

export type Env = Record<string, string>;

const BASE_ENV: Env = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  APP_NAME: 'Closet',
  SITE_URL: 'http://localhost:3000',
  TRUSTED_PROXIES: '127.0.0.1,::1',
  AUTH_ENABLED: 'false',
  DISABLE_REGISTRATION: 'false',
  PWA_ENABLED: 'false',
  ACCESS_TOKEN_SECRET: 'integration-test-secret',
  DATABASE_TYPE: 'sqlite',
  DATABASE_SCHEMA: ':memory:',
  FILE_STORAGE_TYPE: 'local',
};

export const TEST_PASSWORD = 'Password123!';

export interface TestApp {
  app: NestFastifyApplication;
  /** Uploads, thumbs and app.log land here; removed by cleanup(). */
  dataPath: string;
  inject: (options: InjectOptions) => Promise<LightMyRequestResponse>;
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
  Object.assign(process.env, BASE_ENV, { DATA_PATH: dataPath }, overrides);

  // Deferred on purpose: ConfigModule.forRoot validates process.env and
  // DalModule picks its driver when app.module is first evaluated, so the
  // module graph must not load before the env above is in place.
  const { createApp } = await import('../../src/app');
  const app = await createApp();
  await app.init();

  const orm = app.get(MikroORM);
  const inject = (options: InjectOptions) => app.inject(options);
  const sessionFrom = (res: LightMyRequestResponse, action: string) => {
    const token = res.cookies.find((c) => c.name === 'access_token');
    if (!token) {
      throw new Error(
        `${action} did not set access_token (status ${res.statusCode})`,
      );
    }
    return `access_token=${token.value}`;
  };

  return {
    app,
    dataPath,
    inject,
    em: () => orm.em.fork(),
    register: async (email: string, password = TEST_PASSWORD) =>
      sessionFrom(
        await inject({
          method: 'POST',
          url: '/auth/register',
          payload: { email, password, confirmPassword: password },
        }),
        'register',
      ),
    login: async (email: string, password = TEST_PASSWORD) =>
      sessionFrom(
        await inject({
          method: 'POST',
          url: '/auth/login',
          payload: { email, password },
        }),
        'login',
      ),
    cleanup: async () => {
      await app.close();
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
      new Blob([file.data], { type: file.contentType }),
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
