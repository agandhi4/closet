import type {
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { lastMigrationAt, newestMigrationAt } from '../../db/migrate';
import { loggableUrl } from '../loggable-url';
import type { WebOptions } from '../plugin';
import { HEALTH_LIMIT, tooManyAttempts } from '../security/rate-limit';
import {
  checkCutoutQueue,
  checkDatabase,
  checkJobs,
  readiness,
} from './checks';

/**
 * The fleet's two health endpoints (observability.md, Health Contract;
 * src/web/health/AGENTS.md). Public, static paths (static-prefixes.ts: no
 * session, no access line), `no-store` so no cache answers for the server.
 *
 * - GET /health/live checks nothing: 200 while the process serves.
 *   public/js/connectivity.js probes it with HEAD, so the offline banner
 *   never says "offline" because a dependency is down.
 * - GET /health/ready runs the checks (checks.ts): 200 up, 503 down.
 *   The image's HEALTHCHECK, scripts/smoke-image.sh and devkit's
 *   contract probe read it. Rate-limited (HEALTH_LIMIT).
 * - GET /healthz is /health/ready's handler and budget, kept for phones
 *   whose cached connectivity.js still HEADs it (Fastify answers HEAD
 *   from the GET route, without the body).
 */
export const healthRoutes: FastifyPluginCallback<WebOptions> = (
  app,
  { config, db, logger, jobs, cutouts },
  done,
) => {
  const log = logger.child({ logger: 'Health' });
  // Once: it reads (and hashes) every migration file.
  const buildSchemaAt = newestMigrationAt();
  const limit = app.createRateLimit(HEALTH_LIMIT);

  app.get(
    '/health/live',
    { config: { public: true } },
    async (_request, reply) =>
      reply.header('Cache-Control', 'no-store').send({ status: 'up' }),
  );

  const ready = async (request: FastifyRequest, reply: FastifyReply) => {
    const verdict = await limit(request);
    // `isAllowed` is the plugin's allow list; the count is isExceeded.
    if (!verdict.isAllowed && verdict.isExceeded) {
      log.warn(
        `Rate limit reached: ${request.method} ${loggableUrl(request)} for ${request.ip}`,
      );
      throw tooManyAttempts(verdict.ttlInSeconds);
    }
    const body = readiness(config.release, {
      ...(await checkDatabase(() => lastMigrationAt(db), buildSchemaAt, log)),
      cron_jobs: checkJobs(jobs.stuck()),
      cutout_queue: checkCutoutQueue(cutouts.running),
    });
    return reply
      .status(body.status === 'up' ? 200 : 503)
      .header('Cache-Control', 'no-store')
      .send(body);
  };
  app.get('/health/ready', { config: { public: true } }, ready);
  app.get('/healthz', { config: { public: true } }, ready);

  done();
};
