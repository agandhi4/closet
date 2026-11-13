import fastifyRateLimit from '@fastify/rate-limit';
import fastifySwagger from '@fastify/swagger';
import Fastify from 'fastify';
import { join } from 'node:path';
import { pino } from 'pino';
import { PROJECT_ROOT } from '../src/project-root';
import { DEVICE_TOKEN_SCHEME } from '../src/web/api/contract';
import { type ApiOptions, registerApi } from '../src/web/api/plugin';
import { SIGN_IN_LIMIT } from '../src/web/security/rate-limit';
import { assignSurface } from '../src/web/surface';

/**
 * The API's OpenAPI 3.1 document, generated from the TypeBox schemas the
 * /api/v1 routes declare (#190; plan section 5). `npm run api:spec` writes
 * it to SPEC_PATH, which GET /api/v1/openapi.json serves as committed, and
 * scripts/api-spec.spec.ts fails when the committed file is not what this
 * generates: a contract change is a reviewed diff. @fastify/swagger is a
 * devDependency, imported only here.
 */
export const SPEC_PATH = join(PROJECT_ROOT, 'src/web/api/openapi.json');

/**
 * The plugin is registered on a bare instance that never listens or serves
 * a request: registration only passes these references to hooks and
 * handlers, so nothing behind them is ever called. Each is the type's
 * shape and no more; the cast says it is not a working app.
 */
function unservedOptions(): ApiOptions {
  const logger = pino({ level: 'silent' });
  return {
    config: { timeZone: 'UTC' },
    logger,
    apiLogger: logger,
    mcpLogger: logger,
  } as unknown as ApiOptions;
}

export async function generateApiSpec(): Promise<unknown> {
  const app = Fastify();
  await app.register(fastifySwagger, {
    // A shared schema is a component named by its $id (Problem).
    refResolver: {
      buildLocalReference: (json, _baseUri, _fragment, i) =>
        typeof json.$id === 'string' ? json.$id : `def-${i}`,
    },
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Closet API',
        // The contract's version, never the build's: the sha would make
        // every commit a spec change.
        version: 'v1',
        description:
          "Closet's JSON API for native clients. Sign in with POST /api/v1/auth/token and send the device token as `Authorization: Bearer <token>`. A 401 on any route means sign in again. Errors are RFC 9457 problem+json; switch on `code`.",
      },
      components: {
        securitySchemes: {
          [DEVICE_TOKEN_SCHEME]: {
            type: 'http',
            scheme: 'bearer',
            description:
              'A device token from POST /api/v1/auth/token, valid until revoked.',
          },
        },
      },
      security: [{ [DEVICE_TOKEN_SCHEME]: [] }],
    },
  });
  await app.register(fastifyRateLimit, { global: false });
  app.addHook('onRoute', assignSurface);
  await registerApi(app, {
    ...unservedOptions(),
    signInLimit: app.createRateLimit(SIGN_IN_LIMIT),
  });
  await app.ready();
  const spec = app.swagger();
  await app.close();
  return spec;
}

/** The file's bytes: what `npm run api:spec` writes and the drift test compares. */
export function serializeSpec(spec: unknown): string {
  return `${JSON.stringify(spec, null, 2)}\n`;
}
