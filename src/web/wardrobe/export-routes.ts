import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { todayIn } from '../calendar/calendar-date';
import type { WebOptions } from '../plugin';
import { requestOrigin } from '../security/origin';
import { authorizeWardrobe } from '../sharing/access';
import { EXPORT_FORMATS, wardrobeExport } from './export';
import { wardrobeExportPath } from '../page-cache';
import { OwnerQuery } from './validation';

const CONTENT_TYPES = {
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
} as const;

/**
 * GET /wardrobe/export.csv and /wardrobe/export.json (#200), linked from
 * Profile › Export: the requester's own wardrobe as a download. Owner
 * only: `?ownerId=` of a wardrobe shared with them is a 403 (MANAGE
 * included: an export is the whole wardrobe to keep, the owner's own
 * records with it), a stranger's a 404. Never stored by the service worker
 * (bypassesWorker, src/web/page-cache.ts) or the browser (no-store).
 */
export const exportRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { db, config, logger },
  done,
) => {
  for (const format of EXPORT_FORMATS) {
    app.get(
      wardrobeExportPath(format),
      { schema: { querystring: OwnerQuery } },
      async (request, reply) => {
        const { access } = await authorizeWardrobe(
          db,
          request,
          request.query.ownerId,
          'own',
          'Wardrobe not found',
        );
        const day = todayIn(config.timeZone, new Date());
        logger.info(`Export (${format}) of wardrobe ${access.ownerId} started`);
        return reply
          .type(CONTENT_TYPES[format])
          .header(
            'content-disposition',
            `attachment; filename="closet-${day}.${format}"`,
          )
          .header('cache-control', 'no-store')
          .send(
            wardrobeExport(db, logger, {
              ownerId: access.ownerId,
              format,
              origin: requestOrigin(request),
            }),
          );
      },
    );
  }
  done();
};
