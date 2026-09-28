import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import { sessionUserId } from '../auth/require-session';
import { todayIn } from '../calendar/calendar-date';
import { HttpError } from '../errors';
import type { WebOptions } from '../plugin';
import { authorizeWardrobe } from '../sharing/access';
import { findGarment } from './queries';
import { renderGarmentForm } from './render-form';
import { REPAIRS_ANCHOR } from './repair-log';
import {
  addRepair,
  deleteRepair,
  RepairBody,
  RepairParams,
  readRepairForm,
  repairPanel,
} from './repairs';
import { garmentUrl } from './urls';
import { GarmentParams, OwnerQuery, storedFormValues } from './validation';

const GARMENT_NOT_FOUND = 'Garment not found';
const NOT_OWNED_YET = 'On the wishlist: not bought yet';

/**
 * The repair and alteration log's writes (#23; docs/plans/2026-09-26-
 * wardrobe-features.md, section 17), from the edit page's editor
 * (repair-log.tsx). The owner's own record, like wears: a garment in a
 * shared wardrobe is refused to a grantee (403 with `?ownerId=`, where they
 * can see it; 404 without, where it is not in their wardrobe), and a
 * wishlist item is not owned yet (409). Native posts: a refused entry
 * re-renders the edit page (400) with its messages.
 */
export const repairRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { db, config, logger },
  done,
) => {
  /** The requester's own owned garment `id`, or the refusal (see above). */
  async function ownGarment(
    request: FastifyRequest,
    id: number,
    ownerId: number | '' | undefined,
  ) {
    const { access } = await authorizeWardrobe(
      db,
      request,
      ownerId,
      'own',
      GARMENT_NOT_FOUND,
    );
    const garment = await findGarment(db, id, access.ownerId);
    if (!garment) throw new HttpError(404, GARMENT_NOT_FOUND);
    if (garment.status === 'wishlist') {
      throw new HttpError(409, NOT_OWNED_YET);
    }
    return garment;
  }

  /** The edit page's editor, where the writes send the person back. */
  const editorUrl = (id: number) =>
    `${garmentUrl(id, undefined, '/edit')}#${REPAIRS_ANCHOR}`;

  // Logs an entry; 303 to the garment page, where the log shows it.
  app.post(
    '/wardrobe/:id/repairs',
    {
      schema: {
        params: GarmentParams,
        querystring: OwnerQuery,
        body: RepairBody,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const userId = sessionUserId(request);
      const garment = await ownGarment(request, id, request.query.ownerId);
      const today = todayIn(config.timeZone, new Date());
      const form = readRepairForm(request.body, today);
      if (!form.ok) {
        logger.warn(
          `Repair for garment ${id} refused for user ${userId}: ${Object.keys(form.errors).join(', ')}`,
        );
        return renderGarmentForm(
          reply,
          db,
          {
            mode: { kind: 'edit', garmentId: id, wishlist: false },
            suggestionsFrom: userId,
            viewOwner: undefined,
            values: storedFormValues(garment, { owner: true }),
            repairs: repairPanel(garment, true, today, form),
          },
          400,
        );
      }
      const repairId = await addRepair(db, userId, id, form.entry);
      // Deleted, or moved to the wishlist, since it was read above.
      if (repairId === undefined) throw new HttpError(404, GARMENT_NOT_FOUND);
      logger.info(
        `Repair ${repairId} (${form.entry.kind}, ${form.entry.day}${form.entry.cost === null ? '' : `, cost ${form.entry.cost}`}) logged on garment ${id} by user ${userId}`,
      );
      return reply.redirect(
        `${garmentUrl(id, undefined)}?repairSaved=1#${REPAIRS_ANCHOR}`,
        303,
      );
    },
  );

  // Removes an entry; 303 back to the editor.
  app.post(
    '/wardrobe/:id/repairs/:repairId/delete',
    { schema: { params: RepairParams, querystring: OwnerQuery } },
    async (request, reply) => {
      const { id, repairId } = request.params;
      const userId = sessionUserId(request);
      await ownGarment(request, id, request.query.ownerId);
      if (!(await deleteRepair(db, userId, id, repairId))) {
        throw new HttpError(404, 'Repair not found');
      }
      logger.info(
        `Repair ${repairId} removed from garment ${id} by user ${userId}`,
      );
      return reply.redirect(editorUrl(id), 303);
    },
  );

  done();
};
