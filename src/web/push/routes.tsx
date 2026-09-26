import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { Db } from '../../db/client';
import { sessionUserId } from '../auth/require-session';
import { t } from '../i18n';
import type { Logger } from '../../logger';
import { renderFragment } from '../render';
import { HttpError } from '../errors';
import { isPushServiceEndpoint } from './endpoint';
import { deleteDevice, upsertDevice } from './queries';
import type { PushSender, VapidConfig } from './sender';
import { TestResult } from './settings';

/**
 * The browser's PushSubscription.toJSON(), as public/js/push.js posts it.
 * Stored as sent and later handed to web-push, so it is held to its real
 * shape here: an https endpoint (every push service is one) and the RFC 8291
 * keys in base64url (browsers write them unpadded), a 65-byte P-256 point
 * and a 16-byte secret. Anything else is a 400. `expirationTime` and unknown
 * properties are stripped.
 */
const Endpoint = Type.String({
  format: 'uri',
  pattern: '^https://',
  maxLength: 2048,
});
const SubscribeBody = Type.Object({
  endpoint: Endpoint,
  keys: Type.Object({
    p256dh: Type.String({ pattern: '^[A-Za-z0-9_-]{87}=?$' }),
    auth: Type.String({ pattern: '^[A-Za-z0-9_-]{22}(==)?$' }),
  }),
});
const UnsubscribeBody = Type.Object({ endpoint: Endpoint });

// Stored for telling devices apart; the header is the client's to fill.
const USER_AGENT_LIMIT = 512;
// A test that has not arrived in ten minutes is no longer a useful answer.
const TEST_TTL_SECONDS = 600;

export interface PushRouteOptions {
  db: Db;
  logger: Logger;
  appName: string;
  vapid: VapidConfig;
  sender: PushSender;
}

/**
 * /push: Web Push subscriptions of the signed-in user's browsers, and the
 * test send on the profile page (src/web/push/settings.tsx). Registered only
 * when PWA_ENABLED (there is no service worker to receive anything
 * otherwise). Every route needs a session; the writes are fetches and htmx
 * posts, so a signed-out caller gets a 401, and the same-origin check
 * (CSRF) applies as everywhere.
 */
export const pushRoutes: FastifyPluginCallbackTypebox<PushRouteOptions> = (
  app,
  { db, logger, appName, vapid, sender },
  done,
) => {
  // Read by push.js before subscribing and by the service worker when the
  // browser renews a subscription (pushsubscriptionchange).
  app.get('/push/vapid-public-key', async (_request, reply) =>
    reply
      .header('Cache-Control', 'no-cache')
      .type('text/plain; charset=utf-8')
      .send(vapid.publicKey),
  );

  app.post(
    '/push/subscribe',
    { schema: { body: SubscribeBody } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      // The server will POST to this URL: only known push services (SSRF).
      if (!isPushServiceEndpoint(request.body.endpoint)) {
        logger.warn(
          `User ${userId} sent a subscription outside the push services`,
        );
        throw new HttpError(400);
      }
      const deviceId = await upsertDevice(
        db,
        userId,
        request.body,
        request.headers['user-agent']?.slice(0, USER_AGENT_LIMIT),
      );
      logger.info(`User ${userId} confirmed push device ${deviceId}`);
      return reply.status(204).send();
    },
  );

  // 204 whether or not there was a row: the browser has dropped the
  // subscription either way, and another user's row is not this one's to
  // report on.
  app.post(
    '/push/unsubscribe',
    { schema: { body: UnsubscribeBody } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      if (await deleteDevice(db, userId, request.body.endpoint)) {
        logger.info(`User ${userId} turned off push on a device`);
      }
      return reply.status(204).send();
    },
  );

  // An htmx button: always a 200 fragment saying what happened (htmx swaps
  // no 4xx), sent to the caller's own devices only.
  app.post('/push/test', async (request, reply) => {
    const userId = sessionUserId(request);
    const report = await sender.sendToUser(
      userId,
      {
        title: t('PUSH_TEST_TITLE', { appName }),
        body: t('PUSH_TEST_BODY'),
        url: '/auth/profile',
        tag: 'push-test',
      },
      { ttlSeconds: TEST_TTL_SECONDS },
    );
    return renderFragment(reply, <TestResult report={report} />);
  });

  done();
};
