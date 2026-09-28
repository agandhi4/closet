import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { QUANTITY_MAX } from '../../wardrobe/availability';
import { sessionUserId } from '../auth/require-session';
import { HttpError } from '../errors';
import { t } from '../i18n';
import type { WebOptions } from '../plugin';
import { renderFragment } from '../render';
import { authorizeWardrobe } from '../sharing/access';
import { LookalikesContent } from './lookalike-region';
import {
  addCopies,
  closetLookalikes,
  LookalikesQuery,
  readDismissed,
} from './lookalikes';
import { garmentUrl } from './urls';
import { GarmentParams, OwnerQuery } from './validation';

const GARMENT_NOT_FOUND = 'Garment not found';

/**
 * The garment form's duplicate check (#20; docs/plans/2026-09-26-wardrobe-
 * features.md, section 18; lookalikes.ts). Both are part of adding to the
 * addressed wardrobe, so both need the owner or a MANAGE share, as
 * GET /wardrobe/new does; a clone's check addresses the requester's own.
 */
export const lookalikeRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { db, logger },
  done,
) => {
  // The region's contents for the form's current fields: a read, always a
  // fragment. The dismissed list is navigation state (malformed ids are
  // dropped); a field past the form's caps is a 400 like the form's own.
  app.get(
    '/wardrobe/lookalikes',
    { schema: { querystring: LookalikesQuery } },
    async (request, reply) => {
      const { query } = request;
      const { access, viewOwner } = await authorizeWardrobe(
        db,
        sessionUserId(request),
        query.ownerId,
        'manage',
        GARMENT_NOT_FOUND,
      );
      const dismissed = readDismissed(query.lookalikesDismissed);
      const matches = await closetLookalikes(
        db,
        access.ownerId,
        {
          category: query.category ?? '',
          type: query.type ?? '',
          colors: query.color ?? [],
          brand: query.brand ?? '',
        },
        { dismissed },
      );
      if (matches.length > 0) {
        logger.debug(
          `Lookalikes for a new garment in wardrobe ${access.ownerId}: ${matches.map((m) => m.id).join(', ')}${dismissed.length > 0 ? ` (${dismissed.length} dismissed)` : ''}`,
        );
      }
      return renderFragment(
        reply,
        <LookalikesContent panel={{ matches, dismissed, viewOwner }} />,
      );
    },
  );

  // "Add a copy": one more of the closet garment instead of a new garment
  // (addCopies, under the owner lock); 303 to its page with a toast. A
  // native post from the form's LookalikeCopyForm: a refusal is the error
  // page (a garment archived or moved meanwhile is a 409, past the cap too).
  app.post(
    '/wardrobe/:id/copies',
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    async (request, reply) => {
      const { id } = request.params;
      const userId = sessionUserId(request);
      const { access, viewOwner } = await authorizeWardrobe(
        db,
        userId,
        request.query.ownerId,
        'manage',
        GARMENT_NOT_FOUND,
      );
      const outcome = await addCopies(db, access.ownerId, id, 1);
      if (!outcome.ok) {
        logger.info(
          `Copy of garment ${id} refused for user ${userId} (${outcome.reason})`,
        );
        if (outcome.reason === 'not-found') {
          throw new HttpError(404, GARMENT_NOT_FOUND);
        }
        throw new HttpError(
          409,
          outcome.reason === 'too-many'
            ? t('lookalikes.TOO_MANY', { max: QUANTITY_MAX })
            : t('lookalikes.NOT_IN_CLOSET'),
        );
      }
      logger.info(
        `Garment ${id} copy added by user ${userId} in wardrobe ${access.ownerId}: quantity ${outcome.from} -> ${outcome.to}`,
      );
      return reply.redirect(
        garmentUrl(id, viewOwner, '', { copyAdded: 1 }),
        303,
      );
    },
  );

  done();
};
