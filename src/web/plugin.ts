import type { FastifyPluginAsync } from 'fastify';
import type { Db } from '../db/client';
import { createSessionHook } from './auth/require-session';
import { authRoutes } from './auth/routes';
import { tokenRoutes } from './auth/token-routes';
import { mcpRoutes } from './mcp/routes';
import type { SessionTokens } from './auth/tokens';
import { calendarRoutes } from './calendar/routes';
import { capsuleRoutes } from './capsules/routes';
import { fileRoutes } from './files/routes';
import type { Photos } from './files/photos';
import type { Logger } from '../logger';
import { outfitRoutes } from './outfits/routes';
import { planRoutes } from './plans/routes';
import { shoppingRoutes } from './plans/shopping-routes';
import { pushRoutes } from './push/routes';
import type { OutboundFetcher } from './security/outbound-fetch';
import { createPushSender, type VapidConfig } from './push/sender';
import { shareRoutes } from './share/routes';
import { shellRoutes } from './shell/routes';
import { sharingRoutes } from './sharing/routes';
import { linkImportRoutes } from './wardrobe/link-import/routes';
import { wardrobeRoutes } from './wardrobe/routes';
import type { WeatherService } from './weather/service';
import { weatherRoutes } from './weather/routes';
import { wearRoutes } from './wears/routes';
import { wishlistRoutes } from './wishlist/routes';

/** Config the routes read, resolved once by createApp(). */
export interface WebConfig {
  appName: string;
  iconName: string;
  /** APP_TIMEZONE: the household's IANA zone, which decides "today". */
  timeZone: string;
  /** DISABLE_REGISTRATION: the registration routes redirect to the login page. */
  registrationDisabled: boolean;
  /** Web Push identity; set exactly when PWA_ENABLED (no /push routes otherwise). */
  vapid: VapidConfig | undefined;
}

export interface WebOptions {
  config: WebConfig;
  logger: Logger;
  db: Db;
  tokens: SessionTokens;
  /**
   * The process's one Photos, built by createApp() (its thumb single-flight
   * must be shared): garment writes store through it, /file/** serves
   * through it, account deletion and reconciliation unlink through it.
   */
  photos: Photos;
  /** The background-removal queue, woken when a photo is queued. */
  cutouts: { wake(): void };
  /**
   * The process's one outbound fetcher (src/web/security/outbound-fetch.ts),
   * built by createApp(): the only way a route fetches a URL a user
   * supplied (the link import).
   */
  fetcher: OutboundFetcher;
  /**
   * The weather (src/web/weather/service.ts), built by createApp() only
   * when WEATHER_ENABLED: undefined means no weather route, view or tool.
   */
  weather: WeatherService | undefined;
  /** Context `Mcp`: one line per MCP tool call (src/web/mcp). */
  mcpLogger: Logger;
}

/**
 * Every feature's routes, registered by createApp() after the root hooks
 * and plugins (same-origin check, rate limits, body parsers, session and
 * page context at preValidation, security headers, cookies, compression,
 * multipart) and the error handler, all of which a plugin inherits only if
 * they exist when it is registered. Encapsulated: the session gate below
 * applies to these routes, not to the static roots or the not-found
 * handler.
 *
 * Request validation is Fastify's own: each route declares a JSON schema
 * for its body, querystring and params with TypeBox, and the handler's
 * request types are inferred from it (FastifyPluginCallbackTypebox). A
 * request that fails it never reaches the handler: the error handler
 * renders a 400 page with Fastify's message. The session gate and the root
 * hook run at preValidation, before that check, so an anonymous request is
 * sent to log in and a failed validation still has its page context.
 *
 * A new feature is one more `app.register(<feature>Routes, options)`.
 */
export const webPlugin: FastifyPluginAsync<WebOptions> = async (
  app,
  options,
) => {
  const { logger } = options;
  app.addHook('preValidation', createSessionHook(logger));

  await app.register(shellRoutes, options);
  await app.register(wardrobeRoutes, options);
  await app.register(linkImportRoutes, options);
  await app.register(capsuleRoutes, options);
  await app.register(wishlistRoutes, options);
  await app.register(planRoutes, options);
  await app.register(shoppingRoutes, options);
  await app.register(wearRoutes, options);
  await app.register(calendarRoutes, options);
  await app.register(outfitRoutes, options);
  await app.register(authRoutes, options);
  await app.register(tokenRoutes, options);
  await app.register(sharingRoutes, options);
  // WEATHER_ENABLED=false: no /weather route, so nothing stores a location.
  const { weather } = options;
  if (weather) await app.register(weatherRoutes, { ...options, weather });
  // Bearer-authenticated (config.bearer): the session gate above passes it.
  await app.register(mcpRoutes, options);
  const { vapid } = options.config;
  if (vapid) {
    await app.register(pushRoutes, {
      db: options.db,
      logger,
      appName: options.config.appName,
      vapid,
      sender: createPushSender({ db: options.db, logger, vapid }),
    });
  }
  await app.register(fileRoutes, options);
  await app.register(shareRoutes, options);
};
