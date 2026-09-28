import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { CLIENT_TIMING_KINDS } from '../../metrics/metrics';
import { sessionUserId } from '../auth/require-session';
import { HttpError } from '../errors';
import type { WebOptions } from '../plugin';
import { VITALS_LIMIT } from '../security/rate-limit';
import { readBeaconBodies } from './beacon';

/**
 * The metrics' two routes, registered only with METRICS_ENABLED (#115):
 *
 * - `GET /metrics`: the Prometheus exposition for the homelab's vmagent,
 *   which scrapes the container directly over the Docker network. Public
 *   (a scraper has no session) and a static path (no session lookup, no
 *   request log line every 15 s), but only for a direct request: anything
 *   that came through a reverse proxy (Caddy and Pangolin both add
 *   X-Forwarded-For) is a 404, so the public name never serves it.
 * - `POST /metrics/vitals`: the devices' timings from public/js/vitals.js,
 *   session-only, per-user rate-limited (VITALS_LIMIT), capped at
 *   VITALS_MAX_BYTES and validated sample by sample: a route must be one the
 *   app has (Metrics.observeClientTiming), so no URL or id becomes a series.
 */

/** A beacon's largest body: a full batch (MAX_SAMPLES) is under 3 KB. */
export const VITALS_MAX_BYTES = 8 * 1024;
const MAX_SAMPLES = 20;
// A minute: past it a timing is a tab left in the background, not a wait.
const MAX_MS = 60_000;

const Milliseconds = Type.Number({ minimum: 0, maximum: MAX_MS });

const VitalsBody = Type.Object({
  samples: Type.Array(
    Type.Object({
      route: Type.String({ minLength: 1, maxLength: 200 }),
      kind: Type.Union(CLIENT_TIMING_KINDS.map((kind) => Type.Literal(kind))),
      cache: Type.Boolean(),
      // CLIENT_TIMING_METRICS, each optional: a sample carries its kind's.
      ms: Type.Object({
        ttfb: Type.Optional(Milliseconds),
        lcp: Type.Optional(Milliseconds),
        inp: Type.Optional(Milliseconds),
        request: Type.Optional(Milliseconds),
        settle: Type.Optional(Milliseconds),
      }),
    }),
    { minItems: 1, maxItems: MAX_SAMPLES },
  ),
});

export const metricsRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { metrics, logger },
  done,
) => {
  app.get('/metrics', { config: { public: true } }, async (request, reply) => {
    if (
      request.headers['x-forwarded-for'] !== undefined ||
      request.headers.forwarded !== undefined
    ) {
      logger.warn(`Refused /metrics through a proxy from ${request.ip}`);
      throw new HttpError(404);
    }
    const { contentType, body } = await metrics.exposition();
    return reply
      .header('Content-Type', contentType)
      .header('Cache-Control', 'no-store')
      .send(body);
  });

  readBeaconBodies(app, VITALS_MAX_BYTES);

  app.post(
    '/metrics/vitals',
    {
      bodyLimit: VITALS_MAX_BYTES,
      config: { rateLimit: VITALS_LIMIT },
      schema: { body: VitalsBody },
    },
    async (request, reply) => {
      const { samples } = request.body;
      const recorded = samples.filter((sample) =>
        metrics.observeClientTiming(sample),
      ).length;
      if (recorded < samples.length) {
        logger.info(
          `Vitals from user ${sessionUserId(request)}: ${samples.length - recorded} of ${samples.length} sample(s) named no route of this app; dropped`,
        );
      }
      return reply.status(204).send();
    },
  );

  done();
};
