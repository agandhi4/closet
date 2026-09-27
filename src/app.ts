import fastifyCompress from '@fastify/compress';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, LogController } from 'fastify';
import { join } from 'node:path';
import { BUILD_INFO } from './build-info';
import { type Config, trustedProxies } from './config';
import { CutoutQueue } from './cutout/queue';
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
import { createPushSender, type PushSender } from './web/push/sender';
import {
  createOutboundFetcher,
  type OutboundFetcherOptions,
} from './web/security/outbound-fetch';
import { registerRateLimit } from './web/security/rate-limit';
import { createSameOriginHook } from './web/security/same-origin';
import { createViewContextBuilder } from './web/view-context';
import {
  createOpenMeteoClient,
  type WeatherEndpoints,
} from './web/weather/open-meteo';
import {
  createWeatherService,
  type WeatherService,
} from './web/weather/service';

const PUBLIC_DIR = join(PROJECT_ROOT, 'public');
const nodeModule = (...segments: string[]) =>
  join(PROJECT_ROOT, 'node_modules', ...segments);

export interface ClosetApp {
  app: FastifyInstance;
  db: Db;
  /**
   * The process's one Photos (its thumb single-flight must be shared): the
   * web layer's, and the nightly reconciliation's in server.ts.
   */
  photos: Photos;
  /**
   * The background-removal queue, never started here: server.ts starts it
   * with the model (main.ts) or a stub (the e2e test server), the specs with
   * a fake runner. The web layer wakes it when it queues a photo; closing
   * the app stops it.
   */
  cutouts: CutoutQueue;
  /**
   * The Web Push sender, when PWA_ENABLED: the profile's test send, and the
   * reminders server.ts schedules (createApp never does, so the harness and
   * the CLIs send nothing on their own).
   */
  push: PushSender | undefined;
  /** The weather, when WEATHER_ENABLED: the reminders' forecast line. */
  weather: WeatherService | undefined;
}

export interface AppOptions {
  /**
   * The outbound fetcher's test-only options (a scripted resolver, a
   * loopback alias standing in for the internet): the link import's specs
   * pass them; production never does (CLAUDE.md Gotchas).
   */
  outboundFetch?: Pick<OutboundFetcherOptions, 'resolve' | 'destinations'>;
  /**
   * Open-Meteo's stand-in (test/support/weather-stub.ts): its endpoints and
   * the address policy that admits it. The specs and the e2e test server
   * pass it, so no test reaches the real service; production never does.
   */
  weather?: {
    endpoints: WeatherEndpoints;
    fetch: Pick<OutboundFetcherOptions, 'resolve' | 'destinations'>;
  };
}

/**
 * Builds the application without binding a port: migrations, the database
 * pool, Photos, then the Fastify instance with its root hooks, plugins,
 * static roots, error and not-found handlers, and the routes (webPlugin).
 * server.ts listens on it; the integration harness
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
  options: AppOptions = {},
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

  const database = dbConfig(config);
  // Before anything queries: the schema is current or the boot fails.
  await runMigrations(database, logger.child({ context: 'Migrations' }));
  const db = createDb(database, logger.child({ context: 'Db' }));
  const photos = createPhotos(
    photosConfig(config),
    db,
    logger.child({ context: 'Photos' }),
  );
  const cutouts = new CutoutQueue({
    db,
    database,
    photos,
    logger: logger.child({ context: 'Cutout' }),
    pollMs: config.CUTOUT_POLL_SECONDS * 1000,
  });
  // The only fetcher of user-supplied URLs (the link import); one per
  // process, handed to the web layer like Photos.
  const fetcher = createOutboundFetcher({
    logger: logger.child({ context: 'OutboundFetch' }),
    ...options.outboundFetch,
  });
  const weather = createWeather(config, logger, db, options.weather);
  // loadConfig requires both keys when PWA_ENABLED; the sender checks them
  // (and SITE_URL as the https subject) here, so a bad pair fails the boot.
  const vapid = config.PWA_ENABLED
    ? {
        subject: config.SITE_URL,
        publicKey: config.PUBLIC_VAPID_KEY!,
        privateKey: config.PRIVATE_VAPID_KEY!,
      }
    : undefined;
  const push =
    vapid &&
    createPushSender({ db, logger: logger.child({ context: 'Push' }), vapid });

  const app = Fastify({
    trustProxy,
    loggerInstance: logger.child({ context: 'Fastify' }),
    // One line per request comes from the onResponse hook below.
    logController: new LogController({ disableRequestLogging: true }),
  });
  // The queue first: a job still running needs the pool to record itself.
  app.addHook('onClose', async () => {
    await cutouts.stop();
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
  // A cookie that no longer opens a session is ended on this reply
  // (cleared, Clear-Site-Data), whatever the route answers.
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
    weatherEnabled: weather !== undefined,
  });
  // Declared up front so every request object has the same shape; the hook
  // below fills them (both stay undefined on static paths).
  app.decorateRequest('auth', undefined);
  app.decorateReply('locals', undefined);
  // preValidation, not preHandler: schema validation runs between the two,
  // and a request it refuses must already have its session and page context
  // for the 400 page. It runs for the not-found handler too, so a 404 page
  // shows who is signed in.
  // Bearer routes (the MCP endpoint) skip it too: their credential is a
  // token, a cookie never counts there, and without a page context their
  // errors answer as JSON.
  app.addHook('preValidation', async (request, reply) => {
    if (isStaticPath(request.url) || request.routeOptions.config.bearer) {
      return;
    }
    request.auth = await resolveSession(request, reply);
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
    reply.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
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
      vapid,
    },
    logger: web,
    db,
    tokens,
    photos,
    cutouts,
    fetcher,
    weather,
    mcpLogger: logger.child({ context: 'Mcp' }),
    push,
  });

  return { app, db, photos, cutouts, push, weather };
}

/**
 * The weather (#14), or nothing with WEATHER_ENABLED=false: no service, so
 * no route, page or tool can fetch or store a location. Its own outbound
 * fetcher (the same rules as the link import's; see outbound-fetch.ts), so a
 * spec's stand-in for Open-Meteo is admitted for the weather alone.
 */
function createWeather(
  config: Config,
  logger: Logger,
  db: Db,
  stub: AppOptions['weather'],
): WeatherService | undefined {
  const boot = logger.child({ context: 'Bootstrap' });
  if (!config.WEATHER_ENABLED) {
    boot.info('Weather: off (WEATHER_ENABLED=false)');
    return undefined;
  }
  boot.info(
    `Weather: on (${stub ? 'a stand-in for Open-Meteo' : 'Open-Meteo'})`,
  );
  return createWeatherService({
    db,
    client: createOpenMeteoClient({
      fetcher: createOutboundFetcher({
        logger: logger.child({ context: 'OutboundFetch' }),
        ...stub?.fetch,
      }),
      timeZone: config.APP_TIMEZONE,
      endpoints: stub?.endpoints,
    }),
    logger: logger.child({ context: 'Weather' }),
    timeZone: config.APP_TIMEZONE,
  });
}

// Inline script: the pages' one-line handlers and inline modules (CLAUDE.md,
// Conventions). blob: images: the mask editor draws the original and the
// cutout from object URLs. No eval (htmx's filters, hx-on and js: values are
// unused) and no blob: scripts or workers: those were the in-browser
// background-removal model's, removed on 2026-09-26.
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; frame-ancestors 'none';";

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
   * https://blog.wesleyac.com/posts/why-not-javascript-cdn
   * sortablejs is not among them: its ESM build is unminified, so
   * `npm run generate:vendor` minifies it into public/vendor/, served by the
   * public/ root above (views/assets/sortable.js says why). */
  await app.register(fastifyStatic, {
    root: [
      nodeModule('htmx.org/dist'),
      nodeModule('@khmyznikov/pwa-install/dist'),
      nodeModule('workbox-window/build'),
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
}
