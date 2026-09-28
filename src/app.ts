import fastifyCompress from '@fastify/compress';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyMultipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, LogController } from 'fastify';
import { BUILD_INFO } from './build-info';
import { type Config, orderMailSenders, trustedProxies } from './config';
import { countPendingCutouts } from './cutout/queries';
import { CutoutQueue } from './cutout/queue';
import { createDb, type Db, dbConfig } from './db/client';
import { runMigrations } from './db/migrate';
import type { Logger } from './logger';
import { createErrorTracker, type ErrorTracker } from './metrics/error-tracker';
import { registerHttpMetrics } from './metrics/http';
import { Metrics } from './metrics/metrics';
import { registerStaticAssets } from './static-assets';
import { isStaticPath } from './static-prefixes';
import { normalizeEmail } from './web/auth/queries';
import { createSessionResolver } from './web/auth/session';
import { createSessionTokens } from './web/auth/tokens';
import { createErrorHandler, HttpError } from './web/errors';
import { configurePhotoUrls } from './web/files/image-url';
import { createPhotos, type Photos, photosConfig } from './web/files/photos';
import { loggableUrl } from './web/loggable-url';
import { webPlugin } from './web/plugin';
import { createPushSender, type PushSender } from './web/push/sender';
import {
  createOutboundFetcher,
  type OutboundFetcher,
  type OutboundFetcherOptions,
} from './web/security/outbound-fetch';
import { registerRateLimit } from './web/security/rate-limit';
import { createSameOriginHook } from './web/security/same-origin';
import { createViewContextBuilder } from './web/view-context';
import { createJmapClient } from './web/wardrobe/order-mail/jmap';
import type { OrderMailDeps } from './web/wardrobe/order-mail/poll';
import {
  createOpenMeteoClient,
  type WeatherEndpoints,
} from './web/weather/open-meteo';
import {
  createWeatherService,
  type WeatherService,
} from './web/weather/service';

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
  /**
   * The order mail's poll (#25), when ORDER_MAIL_JMAP_TOKEN is set:
   * server.ts schedules it, the specs run it (pollOrderMail).
   */
  orderMail: OrderMailDeps | undefined;
  /**
   * The process's metrics (src/metrics/): recorded always, exposed at
   * GET /metrics only with METRICS_ENABLED; server.ts times its jobs here.
   */
  metrics: Metrics;
  /**
   * The error tracker (src/metrics/error-tracker.ts): Bugsink with
   * SENTRY_DSN, a no-op without. The metrics and the error handler capture
   * through it; closing the app sends what it still holds.
   */
  errors: ErrorTracker;
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
  /**
   * Fastmail's stand-in (test/support/jmap-stub.ts): its session URL and
   * the address policy that admits it. The specs pass it; production never
   * does, so no test reaches Fastmail.
   */
  orderMail?: {
    sessionUrl: string;
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

  boot.info(
    `Metrics: ${config.METRICS_ENABLED ? 'on (GET /metrics, POST /metrics/vitals)' : 'off (METRICS_ENABLED=false)'}`,
  );
  const errors = await createErrorTracker({
    dsn: config.SENTRY_DSN,
    release: BUILD_INFO.sha,
    environment: config.NODE_ENV,
    logger: logger.child({ context: 'ErrorTracking' }),
  });
  // The DSN's host only: its key is a credential of sorts.
  boot.info(
    errors.enabled
      ? `Error tracking: on (${new URL(config.SENTRY_DSN).host}, release ${BUILD_INFO.commit ?? 'unknown'})`
      : 'Error tracking: off (SENTRY_DSN unset)',
  );
  const metrics = new Metrics({
    enabled: config.METRICS_ENABLED,
    logger: logger.child({ context: 'Metrics' }),
    errors,
  });

  const database = dbConfig(config);
  // Before anything queries: the schema is current or the boot fails.
  await runMigrations(database, logger.child({ context: 'Migrations' }));
  const db = createDb(database, logger.child({ context: 'Db' }));
  const photos = createPhotos(
    photosConfig(config),
    db,
    logger.child({ context: 'Photos' }),
  );
  // Before any page renders a /file URL: the key the /file routes verify.
  configurePhotoUrls(config.ACCESS_TOKEN_SECRET);
  const cutouts = new CutoutQueue({
    db,
    database,
    photos,
    logger: logger.child({ context: 'Cutout' }),
    pollMs: config.CUTOUT_POLL_SECONDS * 1000,
    metrics,
  });
  metrics.trackCutoutQueue(() => countPendingCutouts(db));
  // The only fetcher of user-supplied URLs (the link import); one per
  // process, handed to the web layer like Photos.
  const fetcher = createOutboundFetcher({
    logger: logger.child({ context: 'OutboundFetch' }),
    ...options.outboundFetch,
  });
  const weather = createWeather(config, logger, db, options.weather);
  const orderMail = createOrderMail(
    config,
    logger,
    db,
    fetcher,
    options.orderMail,
  );
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
    createPushSender({
      db,
      logger: logger.child({ context: 'Push' }),
      vapid,
      metrics,
    });

  const app = Fastify({
    trustProxy,
    loggerInstance: logger.child({ context: 'Fastify' }),
    // One line per request comes from the onResponse hook below.
    logController: new LogController({ disableRequestLogging: true }),
  });
  // The queue and the weather's background refreshes first: a job still
  // running needs the pool to record itself, a refresh to save its row.
  // The error tracker last, so a failure on the way out is still sent.
  app.addHook('onClose', async () => {
    await Promise.all([cutouts.stop(), weather?.settled()]);
    await db.$client.end();
    await errors.close();
  });

  // First of all the hooks: the request's timing (Server-Timing) must be in
  // place before any hook queries, and every route's template is noted as
  // it is registered.
  registerHttpMetrics(app, metrics);

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
    metricsEnabled: config.METRICS_ENABLED,
    errorTrackingEnabled: errors.enabled,
    orderMailOwner: orderMail?.ownerEmail,
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
  app.addHook('onSend', (_request, reply, payload, done) => {
    reply.headers(SECURITY_HEADERS);
    done(null, payload);
  });

  // One line per request, never its headers (the session cookie is a
  // bearer credential). Static paths (every thumbnail, script and the 30 s
  // heartbeat) stay out: logging them cost ~16% of image throughput. Routes
  // with a secret in the path log their pattern (loggableUrl).
  const http = logger.child({ context: 'Http' });
  app.addHook('onResponse', (request, reply, done) => {
    if (!isStaticPath(request.url)) {
      http.info(
        `${request.method} ${loggableUrl(request)} ${reply.statusCode} ${reply.elapsedTime.toFixed(1)}ms`,
      );
    }
    done();
  });

  await app.register(fastifyCookie);
  // Pages and fragments; a static file goes out precompressed when it has
  // a variant (static-assets.ts), which this leaves alone.
  await app.register(fastifyCompress);
  // Forms post urlencoded bodies; JSON is Fastify's own parser.
  await app.register(fastifyFormbody);
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 100 * 1024 * 1024, // 100MB
      files: 5,
    },
  });

  await registerStaticAssets(
    app,
    config,
    logger.child({ context: 'StaticAssets' }),
  );

  const web = logger.child({ context: 'Web' });
  app.setErrorHandler(createErrorHandler(web, errors));
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
      orderMailOwner: orderMail?.ownerEmail,
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
    metrics,
    errors,
  });

  return {
    app,
    db,
    photos,
    cutouts,
    push,
    weather,
    orderMail,
    metrics,
    errors,
  };
}

/**
 * The order mail's poll (#25), or nothing without ORDER_MAIL_JMAP_TOKEN:
 * no timer, no review list, no menu entry. Its JMAP client has an outbound
 * fetcher of its own, pinned to the session's host (the only one that may
 * see the token), so a spec's stand-in for Fastmail is admitted for it
 * alone; each link in an email goes through `fetcher`, the one for user
 * URLs, like a link the owner pasted.
 */
function createOrderMail(
  config: Config,
  logger: Logger,
  db: Db,
  fetcher: OutboundFetcher,
  stub: AppOptions['orderMail'],
): OrderMailDeps | undefined {
  const boot = logger.child({ context: 'Bootstrap' });
  if (!config.ORDER_MAIL_JMAP_TOKEN) {
    boot.info('Order mail: off (ORDER_MAIL_JMAP_TOKEN unset)');
    return undefined;
  }
  const senders = orderMailSenders(config);
  // The token is never logged; the owner and senders are the owner's own.
  boot.info(
    `Order mail: on (${stub ? 'a stand-in for Fastmail' : 'Fastmail'}, every ${config.ORDER_MAIL_POLL_MINUTES} min, ${senders.length} trusted senders)`,
  );
  return {
    db,
    jmap: createJmapClient({
      fetcher: createOutboundFetcher({
        logger: logger.child({ context: 'OutboundFetch' }),
        ...stub?.fetch,
      }),
      token: config.ORDER_MAIL_JMAP_TOKEN,
      sessionUrl: stub?.sessionUrl,
    }),
    fetcher,
    senders,
    ownerEmail: normalizeEmail(config.ORDER_MAIL_OWNER),
    timeZone: config.APP_TIMEZONE,
    logger: logger.child({ context: 'OrderMail' }),
  };
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

// Every response's, set by the root onSend hook.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
} as const;
