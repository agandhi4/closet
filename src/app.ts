import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import fastifyCompress from '@fastify/compress';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { join } from 'path';
import { AppModule } from './app.module';
import { loadConfig, trustedProxies } from './config';
import { Logger } from 'nestjs-pino';
import { ViewContextService } from './view-context/view-context.service';
import { isStaticPath } from './static-prefixes';
import { PROJECT_ROOT } from './project-root';
import { BUILD_INFO } from './build-info';
import { ConfigService } from '@nestjs/config';
import { Logger as NestLogger } from '@nestjs/common';
import type { Db } from './db/client';
import { DB } from './db/db.module';
import { webPlugin } from './web/plugin';
import {
  createPhotos,
  type Photos,
  type PhotosConfig,
} from './web/files/photos';
import { createSessionResolver } from './web/auth/session';
import { createSessionTokens } from './web/auth/tokens';
import { registerRateLimit } from './web/security/rate-limit';
import { createSameOriginHook } from './web/security/same-origin';

const PUBLIC_DIR = join(PROJECT_ROOT, 'public');
const nodeModule = (...segments: string[]) =>
  join(PROJECT_ROOT, 'node_modules', ...segments);

/** Where photos live and how share previews are made, from config. */
export function photosConfig(config: ConfigService): PhotosConfig {
  return {
    dataPath: config.getOrThrow<string>('DATA_PATH'),
    maxHeicBytes: config.getOrThrow<number>('MAX_HEIC_BYTES'),
    watermarkIconPath: join(
      PUBLIC_DIR,
      'assets',
      config.getOrThrow<string>('ICON_NAME'),
    ),
    watermarkEnabled: config.getOrThrow<boolean>('WATERMARK_ENABLED'),
  };
}

export interface ClosetApp {
  app: NestFastifyApplication;
  /**
   * The process's one Photos (its thumb single-flight must be shared): the
   * web layer's, and the nightly reconciliation's in main.ts.
   */
  photos: Photos;
}

/**
 * Builds the fully configured application without binding a port: adapter,
 * per-request session hook, security headers, plugins and static asset
 * roots. main.ts listens on it; the integration
 * harness (test/integration/harness.ts) calls app.init() and drives it with
 * app.inject().
 */
export async function createApp(): Promise<ClosetApp> {
  // Reverse proxies whose X-Forwarded-* headers are believed, so the rate
  // limits, the same-origin check and canonical URLs see the real client and
  // the address it asked for. Behind Caddy this must include Caddy's
  // address (CLAUDE.md, Deployment). Loaded here because the adapter must
  // exist before ConfigService does.
  const trustProxy = trustedProxies(loadConfig());
  const adapter = new FastifyAdapter({ trustProxy });
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    adapter,
    {
      bufferLogs: true,
    },
  );
  app.useLogger(app.get(Logger));
  // bufferLogs holds every Logger call until listen(); an app that is only
  // init()ed (the integration harness) would otherwise buffer forever and
  // emit nothing, so flush as soon as the real logger is in place.
  app.flushLogs();

  app.get(Logger).log(`Trusted proxies: ${trustProxy.join(', ')}`, 'Bootstrap');
  app
    .get(Logger)
    .log(
      `Build ${BUILD_INFO.version} (${BUILD_INFO.commit ?? 'no commit'}), static cache key ${BUILD_INFO.assetVersion}`,
      'Bootstrap',
    );

  const config = app.get(ConfigService);
  const db = app.get<Db>(DB);
  const fastify = app.getHttpAdapter().getInstance();
  const photos = createPhotos(
    photosConfig(config),
    db,
    new NestLogger('Photos'),
  );

  // CSRF: every POST/PUT/PATCH/DELETE, Nest route or web route, must come
  // from this site's own pages. A root hook added before app.init(), so it
  // precedes every route; see src/web/security/same-origin.ts.
  fastify.addHook(
    'onRequest',
    createSameOriginHook({
      siteUrl: config.getOrThrow<string>('SITE_URL'),
      logger: new NestLogger('Security'),
    }),
  );
  // Per-route brute-force limits (login, registration, password changes);
  // before the web plugin so its routes see the plugin's onRoute hook.
  await registerRateLimit(fastify, new NestLogger('RateLimit'));

  // One session resolution per request: the JWT is verified and the user
  // loaded here and nowhere else (guards and views read req.auth). Static
  // paths skip everything, so asset requests never touch the database.
  // Express-like res.locals equivalent: https://github.com/fastify/fastify/issues/303
  const tokens = createSessionTokens(
    config.getOrThrow<string>('ACCESS_TOKEN_SECRET'),
  );
  const resolveSession = createSessionResolver({
    db,
    tokens,
    logger: new NestLogger('Session'),
  });
  const viewContextService = app.get(ViewContextService);
  // Declared up front so every request object has the same shape; the hook
  // below fills them (both stay undefined on static paths).
  fastify.decorateRequest('auth', undefined);
  fastify.decorateReply('locals', undefined);
  // preValidation, not preHandler: the web layer's schema validation
  // (src/web/plugin.ts) runs between the two, and a request it refuses must
  // already have its session and page context for the 400 page. Nest routes
  // are unaffected (guards run inside Nest's handler).
  fastify.addHook('preValidation', async (req, reply) => {
    if (isStaticPath(req.url)) return;
    req.auth = await resolveSession(req);
    reply.locals = viewContextService.buildContext(req, req.auth);
  });

  // Security headers on all responses
  fastify.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains',
    );
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' blob: https://static.cloudflareinsights.com; worker-src 'self' blob:; frame-ancestors 'none';",
    );
    return payload;
  });

  await app.register(fastifyCookie);
  // https://docs.nestjs.com/techniques/compression
  await app.register(fastifyCompress);
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 100 * 1024 * 1024, // 100MB
      files: 5,
    },
  });

  await registerStaticAssets(app);

  // Nest adds its JSON and urlencoded body parsers in app.init(), after the
  // web plugin below, and a Fastify plugin only inherits the content-type
  // parsers its parent had when it was registered: without this a form post
  // to a web-layer route is a 415. The adapter records the registration, so
  // app.init() does not add them twice — which also means app.init()'s own
  // call, the one that would pass a global prefix and the rawBody option, is
  // skipped. Neither is used today; adding either requires passing them here.
  adapter.registerParserMiddleware();

  // Ported features (src/web/), beside Nest's routes on the same instance.
  // Last, so the root hooks and plugins above (same-origin check, rate
  // limits, body parsers, session, security headers, cookies, compression)
  // are in place for its routes.
  await fastify.register(webPlugin, {
    config: {
      appName: config.getOrThrow<string>('APP_NAME'),
      iconName: config.getOrThrow<string>('ICON_NAME'),
      timeZone: config.getOrThrow<string>('APP_TIMEZONE'),
      registrationDisabled: config.getOrThrow<boolean>('DISABLE_REGISTRATION'),
      // The Joi schema requires both keys when PWA_ENABLED; the sender
      // checks them (and SITE_URL as the https subject) at boot.
      vapid: config.getOrThrow<boolean>('PWA_ENABLED')
        ? {
            subject: config.getOrThrow<string>('SITE_URL'),
            publicKey: config.getOrThrow<string>('PUBLIC_VAPID_KEY'),
            privateKey: config.getOrThrow<string>('PRIVATE_VAPID_KEY'),
          }
        : undefined,
    },
    logger: new NestLogger('Web'),
    db,
    tokens,
    photos,
  });

  return { app, photos };
}

// Every static URL is versioned (`?v=` from BUILD_INFO.assetVersion in
// the layout and the importmap; `?v=<photo version>` on /file/**), so a deploy
// changes URLs, never the bytes behind one: a year, immutable. The two files
// whose URL cannot change keep revalidating: sw.js below (the browser must
// see a new worker to update the app shell) and manifest.json (a route in
// src/web/shell). NODE_ENV=development turns caching off so `tailwind
// --watch` output shows up on a plain reload.
const IMMUTABLE_YEAR = 'public, max-age=31536000, immutable';
const REVALIDATE = 'public, max-age=0';
const SERVICE_WORKER_CACHE_CONTROL = 'no-cache';

// Keep in step with STATIC_PREFIXES in static-prefixes.ts: every root here
// must be a path the session hook skips.
//
// Registers @fastify/static directly rather than through Nest's
// useStaticAssets(): that helper registers the same plugin, but its options
// type is a stale copy (platform-fastify 11.2.6 still types setHeaders' first
// argument as a raw response with setHeader(), while @fastify/static 10 passes
// the FastifyReply). The plugin's own types are the ones that match runtime.
async function registerStaticAssets(app: NestFastifyApplication) {
  const dev = app.get(ConfigService).get<string>('NODE_ENV') === 'development';
  const cacheControl = dev ? REVALIDATE : IMMUTABLE_YEAR;
  // Per-file policy: since @fastify/static 10, setHeaders receives the
  // FastifyReply and runs after send's headers, so its Cache-Control wins.
  // (Before 10 it was the raw response and send overwrote it afterwards.)
  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    decorateReply: false,
    setHeaders: (reply, path) => {
      reply.header(
        'Cache-Control',
        path.endsWith('sw.js') ? SERVICE_WORKER_CACHE_CONTROL : cacheControl,
      );
    },
  });

  const immutable = dev
    ? { maxAge: 0, immutable: false }
    : { maxAge: '1y', immutable: true };

  /** Serve htmx and other libraries from node_modules
   * https://htmx.org/docs/#installing
   * https://blog.wesleyac.com/posts/why-not-javascript-cdn */
  await app.register(fastifyStatic, {
    root: [
      nodeModule('htmx.org/dist'),
      nodeModule('hyperscript.org/dist'),
      nodeModule('@khmyznikov/pwa-install/dist'),
      nodeModule('workbox-window/build'),
      nodeModule('sortablejs'),
    ],
    prefix: '/modules/',
    decorateReply: false,
    ...immutable,
  });

  await app.register(fastifyStatic, {
    root: nodeModule('pulltorefreshjs/dist'),
    prefix: '/modules/pulltorefresh',
    decorateReply: false,
    ...immutable,
  });
  // The background-removal runtime and models are fetched by the library
  // with unversioned relative URLs (resources.json and chunk imports), so the
  // service worker revalidates them (NetworkFirst, cache:'no-cache' in
  // src-sw.ts) instead of trusting this header.
  await app.register(fastifyStatic, {
    root: nodeModule('@imgly/background-removal/dist'),
    prefix: '/modules/background-removal',
    decorateReply: false,
    ...immutable,
  });
  await app.register(fastifyStatic, {
    root: nodeModule('onnxruntime-web'),
    prefix: '/modules/onnxruntime-web',
    decorateReply: false,
    ...immutable,
  });
  await app.register(fastifyStatic, {
    root: nodeModule('@imgly/background-removal-data/dist'),
    prefix: '/bg-removal-models',
    decorateReply: false,
    ...immutable,
  });
}
