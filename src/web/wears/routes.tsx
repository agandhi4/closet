import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AWAY_REASONS } from '../../wardrobe/availability';
import { sessionUserId } from '../auth/require-session';
import { AutosaveSaved } from '../autosave';
import { todayIn } from '../../calendar-date';
import { HttpError } from '../errors';
import type { WebOptions } from '../plugin';
import { renderFragment, renderPage } from '../render';
import { GarmentParams, OwnerQuery, RowId } from '../schemas';
import { sharedWardrobesOf } from '../sharing/access';
import { viewContext } from '../view-context';
import {
  authorizeGarmentWardrobe,
  garmentNotFound,
} from '../wardrobe/garment-access';
import { findGarment } from '../wardrobe/queries';
import { garmentUrl, LAUNDRY_PATH } from '../wardrobe/urls';
import { CARE_NOTE_MAX } from '../wardrobe/garment-input';
import { LaundryPage } from './laundry-page';
import {
  laundryList,
  markWashed,
  setAway,
  setWoreToday,
  wearStatusOf,
} from './queries';
import { WearStatus } from './wear-section';

const NOT_OWNED_YET = 'On the wishlist: not bought yet';

const WoreTodayBody = Type.Object({
  worn: Type.Union([Type.Literal('1'), Type.Literal('0')]),
});

const AwayBody = Type.Object({
  // '' is back in the closet.
  away: Type.Union([
    Type.Literal(''),
    ...AWAY_REASONS.map((reason) => Type.Literal(reason)),
  ]),
  awayNote: Type.Optional(Type.String({ maxLength: CARE_NOTE_MAX })),
});

const LaundryBody = Type.Union([
  Type.Object({ ids: Type.Optional(Type.Array(RowId, { maxItems: 2000 })) }),
  Type.Null(),
]);

const LaundryQuery = Type.Object({
  // One-shot flag from POST /laundry's redirect (the toast).
  washed: Type.Optional(Type.Integer({ minimum: 0 })),
});

/**
 * Wears, washes and away (docs/plans/2026-09-26-wardrobe-features.md,
 * section 1): the garment page's Wore today, Washed and "where is it", and
 * /laundry. The owner's own records, like outfits and the calendar: a
 * garment in a shared wardrobe is refused to a grantee (403 with
 * `?ownerId=`, where they can see it; 404 without, where it is not in
 * their wardrobe), and /laundry is always the signed-in user's own
 * (`?ownerId=` ignored). The calendar's worn pill is POST /calendar/:id/worn
 * (setEntryWorn, the same query layer).
 */
export const wearRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { db, config, logger },
  done,
) => {
  const today = () => todayIn(config.timeZone, new Date());

  /** The requester's own wardrobe, or the refusal (see above). */
  async function ownWardrobe(
    request: FastifyRequest,
    ownerId: number | '' | undefined,
  ): Promise<number> {
    const { access } = await authorizeGarmentWardrobe(
      db,
      request,
      ownerId,
      'own',
    );
    return access.ownerId;
  }

  /**
   * Why a write found nothing to change: garment `id` is not the owner's
   * (404), or is a wishlist item, visible but not owned yet: nothing to
   * wear, wash or lend (409). Each writer refuses both itself, so the
   * garment is read only on this path: a write that lands looks nothing up
   * first (#160).
   */
  function refusal(outcome: 'not-found' | 'wishlist'): HttpError {
    return outcome === 'wishlist'
      ? new HttpError(409, NOT_OWNED_YET)
      : garmentNotFound();
  }

  /** refusal for a writer that answers only whether it wrote (markWashed, setAway). */
  async function refusalOf(id: number, ownerId: number): Promise<HttpError> {
    const garment = await findGarment(db, id, ownerId);
    return refusal(garment?.status === 'wishlist' ? 'wishlist' : 'not-found');
  }

  /** The wear status again to htmx; the garment page to a plain post. */
  async function answer(
    request: FastifyRequest,
    reply: FastifyReply,
    id: number,
    ownerId: number,
  ): Promise<FastifyReply> {
    if (!request.headers['hx-request']) {
      return reply.redirect(garmentUrl(id, undefined), 303);
    }
    const day = today();
    const status = await wearStatusOf(db, id, ownerId, day);
    if (!status) throw garmentNotFound();
    return renderFragment(
      reply,
      <WearStatus
        garment={status.garment}
        panel={{ summary: status.summary, today: day }}
      />,
    );
  }

  // Wore today (worn=1) and its undo the same day (worn=0).
  app.post(
    '/wardrobe/:id/wear',
    {
      schema: {
        params: GarmentParams,
        querystring: OwnerQuery,
        body: WoreTodayBody,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const ownerId = await ownWardrobe(request, request.query.ownerId);
      const worn = request.body.worn === '1';
      const day = today();
      const outcome = await setWoreToday(db, {
        garmentId: id,
        ownerId,
        day,
        worn,
      });
      if (outcome !== 'saved') throw refusal(outcome);
      logger.info(
        `Garment ${id} ${worn ? 'worn' : 'wear undone'} on ${day} by user ${ownerId}`,
      );
      return answer(request, reply, id, ownerId);
    },
  );

  app.post(
    '/wardrobe/:id/washed',
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    async (request, reply) => {
      const { id } = request.params;
      const ownerId = await ownWardrobe(request, request.query.ownerId);
      const day = today();
      const washed = await markWashed(db, ownerId, [id], day);
      if (washed.length === 0) throw await refusalOf(id, ownerId);
      logger.info(`Garment ${id} washed on ${day} by user ${ownerId}`);
      return answer(request, reply, id, ownerId);
    },
  );

  app.post(
    '/wardrobe/:id/away',
    {
      schema: {
        params: GarmentParams,
        querystring: OwnerQuery,
        body: AwayBody,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const ownerId = await ownWardrobe(request, request.query.ownerId);
      const { away, awayNote } = request.body;
      const saved = await setAway(
        db,
        ownerId,
        id,
        away === '' ? null : { reason: away, note: awayNote?.trim() || null },
      );
      if (!saved) throw await refusalOf(id, ownerId);
      logger.info(
        `Garment ${id} ${away === '' ? 'back in the closet' : `away (${away})`} for user ${ownerId}`,
      );
      // "Where it is" is an AutosaveForm: its status line, never the form.
      if (!request.headers['hx-request']) {
        return reply.redirect(garmentUrl(id, undefined), 303);
      }
      return renderFragment(reply, <AutosaveSaved />);
    },
  );

  // The laundry page, the Wardrobe's Laundry tab: what needs a wash
  // (checked) and what was worn but is not due yet, as one native form
  // (PostForm).
  app.get(
    LAUNDRY_PATH,
    { schema: { querystring: LaundryQuery } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const [items, sharedWardrobes] = await Promise.all([
        laundryList(db, userId),
        sharedWardrobesOf(db, userId),
      ]);
      return renderPage(
        reply,
        <LaundryPage
          ctx={viewContext(reply)}
          items={items}
          sharedWardrobes={sharedWardrobes}
          washed={request.query.washed}
        />,
      );
    },
  );

  // "Mark washed": every checked garment of the user's, today; other ids
  // are ignored like unknown ones. Back to the page with the count.
  app.post(
    LAUNDRY_PATH,
    { schema: { body: LaundryBody } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const ids = request.body?.ids ?? [];
      const day = today();
      const washed = await markWashed(db, userId, ids, day);
      logger.info(
        `Laundry by user ${userId} on ${day}: ${washed.length} washed of ${ids.length} checked`,
      );
      return reply.redirect(`${LAUNDRY_PATH}?washed=${washed.length}`, 303);
    },
  );

  done();
};
