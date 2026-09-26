import type { FastifyPluginCallback } from 'fastify';
import type { WebOptions } from '../plugin';
import { renderPage } from '../render';
import { viewContext } from '../view-context';
import { AboutPage } from './about-page';
import { webManifest } from './manifest';
import { OfflinePage } from './offline-page';

/**
 * The app shell outside any feature: the entry redirect, the PWA's manifest,
 * heartbeat and offline fallback, the about page. Every route but `/` is
 * public: the browser fetches the manifest without credentials, the heartbeat
 * must answer anyone, and the service worker may install before sign-in.
 */
export const shellRoutes: FastifyPluginCallback<WebOptions> = (
  app,
  { config },
  done,
) => {
  // There is no landing page: the wardrobe is the app. Protected, so a
  // signed-out visitor goes straight to the login page.
  app.get('/', async (_request, reply) => reply.redirect('/wardrobe', 302));

  // no-cache (revalidate, like sw.js): the installed app must pick up
  // APP_NAME/ICON_NAME changes on its next check. A static path
  // (static-prefixes.ts): no session, no page context.
  app.get(
    '/manifest.json',
    { config: { public: true } },
    async (_request, reply) =>
      reply
        .type('application/manifest+json; charset=utf-8')
        .header('Cache-Control', 'no-cache')
        .send(webManifest(config)),
  );

  // Heartbeat for public/js/connectivity.js: the client decides it is online
  // only when this answers, never from navigator.onLine. A static path, so
  // the session hook skips it, and no-store so neither the HTTP cache nor the
  // service worker can answer on the server's behalf.
  app.get('/healthz', { config: { public: true } }, async (_request, reply) =>
    reply.status(204).header('Cache-Control', 'no-store').send(),
  );

  app.get('/about', { config: { public: true } }, async (_request, reply) =>
    renderPage(reply, <AboutPage ctx={viewContext(reply)} />),
  );

  app.get(
    '/offline.html',
    { config: { public: true } },
    async (_request, reply) =>
      renderPage(reply, <OfflinePage ctx={viewContext(reply)} />),
  );

  // Browsers and tools probe /.well-known/ (Chrome DevTools, app links); an
  // empty object keeps those probes out of the error log.
  app.get(
    '/.well-known/*',
    { config: { public: true } },
    async (_request, reply) => reply.send({}),
  );
  done();
};
