import fastifyCompress from '@fastify/compress';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, LogController } from 'fastify';
import { join } from 'node:path';
import { BUILD_INFO } from './build-info';
import { type Config, trustedProxies } from './config';
import { createDb, type Db, dbConfig } from './db/client';
import { runMigrations } from './db/migrate';
import type { Logger } from './logger';
import { PROJECT_ROOT } from './project-root';
import { isStaticPath } from './static-prefixes';
import { createSessionResolver } from './web/auth/session';
import { createSessionTokens } from './web/auth/tokens';
import { createErrorHandler, HttpError } from './web/errors';
import { createPhotos, type Photos, photosConfig } from './web/files/photos';
import { loggableUrl } from './web/loggable-url';
import { webPlugin } from './web/plugin';
import { registerRateLimit } from './web/security/rate-limit';
import { createSameOriginHook } from './web/security/same-origin';
import { createViewContextBuilder } from './web/view-context';

const PUBLIC_DIR = join(PROJECT_ROOT, 'public');
const nodeModule = (...segments: string[]) =>
  join(PROJECT_ROOT, 'node_modules', ...segments);

export interface ClosetApp {
  app: FastifyInstance;
  db: Db;
  /**
   * The process's one Photos (its thumb single-flight must be shared): the
   * web layer's, and the nightly reconciliation's in main.ts.
   */
  photos: Photos;
}

/**
 * Builds the application without binding a port: migrations, the database
 * pool, Photos, then the Fastify instance with its root hooks, plugins,
 * static roots, error and not-found handlers, and the routes (webPlugin).
 * main.ts listens on it; the integration harness
 * (test/integration/harness.ts) drives it with inject(). Closing the app
 * ends the pool.
 *
 * Registration order is behavior: a Fastify plugin inherits only the hooks,
 * content-type parsers, decorators and error handler its parent had when it
 * was registered, so everything below comes before webPlugin.
 */
export async function createApp(
  config: Config,
  logger: Logger,
): Promise<ClosetApp> {
  const boot = logger.child({ context: 'Bootstrap' });
  // Reverse proxies whose X-Forwarded-* headers are believed, so the rate
  // limits, the same-origin check and canonical URLs see the real client and
  // the address it asked for. Behind Caddy this must include Caddy's
  // address (CLAUDE.md, Deployment).
  const trustProxy = trustedProxies(config);
  boot.info(`NODE_ENV: ${config.NODE_ENV}`);
  boot.info(`DATA_PATH: ${config.DATA_PATH}`);
  boot.info(`Trusted proxies: ${trustProxy.join(', ')}`);
  boot.info(
    `Build ${BUILD_INFO.version} (${BUILD_INFO.commit ?? 'no commit'}), static cache key ${BUILD_INFO.assetVersion}`,
  );

  // Before anything queries: the schema is current or the boot fails.
  await runMigrations(
    dbConfig(config),
    logger.child({ context: 'Migrations' }),
  );
  const db = createDb(dbConfig(config), logger.child({ context: 'Db' }));
  const photos = createPhotos(
    photosConfig(config),
    db,
    logger.child({ context: 'Photos' }),
  );

  const app = Fastify({
    trustProxy,
    loggerInstance: logger.child({ context: 'Fastify' }),
    // One line per request comes from the onResponse hook below.
    logController: new LogController({ disableRequestLogging: true }),
  });
  app.addHook('onClose', async () => {
    await db.$client.end();
  });

  // CSRF: every POST/PUT/PATCH/DELETE must come from this site's own pages.
  // onRequest, so it precedes every route and the body is never read; see
  // src/web/security/same-origin.ts.
  app.addHook(
    'onRequest',
    createSameOriginHook({
      siteUrl: config.SITE_URL,
      logger: logger.child({ context: 'Security' }),
    }),
  );
  // Per-route brute-force limits (login, registration, password changes);
  // before the routes so they see the plugin's onRoute hook.
  await registerRateLimit(app, logger.child({ context: 'RateLimit' }));

  // One session resolution per request: the JWT is verified and the user
  // loaded here and nowhere else (the session gate and views read req.auth).
  // Static paths skip everything, so asset requests never touch the database.
  const tokens = createSessionTokens(config.ACCESS_TOKEN_SECRET);
  const resolveSession = createSessionResolver({
    db,
    tokens,
    logger: logger.child({ context: 'Session' }),
  });
  const buildViewContext = createViewContextBuilder({
    appName: config.APP_NAME,
    iconName: config.ICON_NAME,
    siteUrl: config.SITE_URL,
    registrationDisabled: config.DISABLE_REGISTRATION,
    pwaEnabled: config.PWA_ENABLED,
  });
  // Declared up front so every request object has the same shape; the hook
  // below fills them (both stay undefined on static paths).
  app.decorateRequest('auth', undefined);
  app.decorateReply('locals', undefined);
  // preValidation, not preHandler: schema validation runs between the two,
  // and a request it refuses must already have its session and page context
  // for the 400 page. It runs for the not-found handler too, so a 404 page
  // shows who is signed in.
  app.addHook('preValidation', async (request, reply) => {
    if (isStaticPath(request.url)) return;
    request.auth = await resolveSession(request);
    reply.locals = buildViewContext(request, request.auth);
  });

  // Security headers on all responses
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains',
    );
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'none';",
    );
    return payload;
  });

  // One line per request, never its headers (the session cookie is a
  // bearer credential). Static paths (every thumbnail, script and the 30 s
  // heartbeat) stay out: logging them cost ~16% of image throughput. Routes
  // with a secret in the path log their pattern (loggableUrl).
  const http = logger.child({ context: 'Http' });
  app.addHook('onResponse', async (request, reply) => {
    if (isStaticPath(request.url)) return;
    http.info(
      `${request.method} ${loggableUrl(request)} ${reply.statusCode} ${reply.elapsedTime.toFixed(1)}ms`,
    );
  });

  await app.register(fastifyCookie);
  await app.register(fastifyCompress);
  // Forms post urlencoded bodies; JSON is Fastify's own parser.
  await app.register(fastifyFormbody);
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 100 * 1024 * 1024, // 100MB
      files: 5,
    },
  });

  await registerStaticAssets(app, config);

  const web = logger.child({ context: 'Web' });
  app.setErrorHandler(createErrorHandler(web));
  // A path no route matches is the 404 page (a static path, which has no
  // page context, gets data from the error handler instead).
  app.setNotFoundHandler((request) => {
    throw new HttpError(404, `Cannot ${request.method} ${request.url}`);
  });

  await app.register(webPlugin, {
    config: {
      appName: config.APP_NAME,
      iconName: config.ICON_NAME,
      timeZone: config.APP_TIMEZONE,
      registrationDisabled: config.DISABLE_REGISTRATION,
      // loadConfig requires both keys when PWA_ENABLED; the sender checks
      // them (and SITE_URL as the https subject) at boot.
      vapid: config.PWA_ENABLED
        ? {
            subject: config.SITE_URL,
            publicKey: config.PUBLIC_VAPID_KEY!,
            privateKey: config.PRIVATE_VAPID_KEY!,
          }
        : undefined,
    },
    logger: web,
    db,
    tokens,
    photos,
  });

  return { app, db, photos };
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
async function registerStaticAssets(app: FastifyInstance, config: Config) {
  const dev = config.NODE_ENV === 'development';
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
