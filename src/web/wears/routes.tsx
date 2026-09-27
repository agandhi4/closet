import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AWAY_REASONS } from '../../wardrobe/availability';
import { sessionUserId } from '../auth/require-session';
import { AutosaveSaved } from '../autosave';
import { todayIn } from '../calendar/calendar-date';
import { HttpError } from '../errors';
import type { WebOptions } from '../plugin';
import { renderFragment, renderPage } from '../render';
import { RowId } from '../schemas';
import { authorizeWardrobe } from '../sharing/access';
import { viewContext } from '../view-context';
import { findGarment } from '../wardrobe/queries';
import { garmentUrl } from '../wardrobe/urls';
import {
  CARE_NOTE_MAX,
  GarmentParams,
  OwnerQuery,
} from '../wardrobe/validation';
import { LaundryPage } from './laundry-page';
import {
  laundryList,
  markWashed,
  setAway,
  setWoreToday,
  wearSummary,
} from './queries';
import { WearStatus } from './wear-section';

const GARMENT_NOT_FOUND = 'Garment not found';
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

  /**
   * The owner's garment `id`, or the refusal (see above). A wishlist item
   * is visible but not owned yet: nothing to wear, wash or lend (409).
   */
  async function ownGarment(
    request: FastifyRequest,
    id: number,
    ownerId: number | '' | undefined,
  ) {
    const { access } = await authorizeWardrobe(
      db,
      sessionUserId(request),
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

  /** The wear status again to htmx; the garment page to a plain post. */
  async function answer(
    request: FastifyRequest,
    reply: FastifyReply,
    id: number,
  ): Promise<FastifyReply> {
    if (!request.headers['hx-request']) {
      return reply.redirect(garmentUrl(id, undefined), 303);
    }
    const day = today();
    const [garment, summary] = await Promise.all([
      findGarment(db, id, sessionUserId(request)),
      wearSummary(db, id, day),
    ]);
    if (!garment) throw new HttpError(404, GARMENT_NOT_FOUND);
    return renderFragment(
      reply,
      <WearStatus garment={garment} panel={{ summary, today: day }} />,
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
      const garment = await ownGarment(request, id, request.query.ownerId);
      const worn = request.body.worn === '1';
      const day = today();
      await setWoreToday(db, {
        garmentId: garment.id,
        ownerId: sessionUserId(request),
        day,
        worn,
      });
      logger.info(
        `Garment ${id} ${worn ? 'worn' : 'wear undone'} on ${day} by user ${sessionUserId(request)}`,
      );
      return answer(request, reply, id);
    },
  );

  app.post(
    '/wardrobe/:id/washed',
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    async (request, reply) => {
      const { id } = request.params;
      await ownGarment(request, id, request.query.ownerId);
      const day = today();
      await markWashed(db, sessionUserId(request), [id], day);
      logger.info(
        `Garment ${id} washed on ${day} by user ${sessionUserId(request)}`,
      );
      return answer(request, reply, id);
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
      await ownGarment(request, id, request.query.ownerId);
      const { away, awayNote } = request.body;
      await setAway(
        db,
        sessionUserId(request),
        id,
        away === '' ? null : { reason: away, note: awayNote?.trim() || null },
      );
      logger.info(
        `Garment ${id} ${away === '' ? 'back in the closet' : `away (${away})`} for user ${sessionUserId(request)}`,
      );
      // "Where it is" is an AutosaveForm: its status line, never the form.
      if (!request.headers['hx-request']) {
        return reply.redirect(garmentUrl(id, undefined), 303);
      }
      return renderFragment(reply, <AutosaveSaved />);
    },
  );

  // The laundry page: what needs a wash (checked) and what was worn but is
  // not due yet, as one native form (PostForm).
  app.get(
    '/laundry',
    { schema: { querystring: LaundryQuery } },
    async (request, reply) => {
      const items = await laundryList(db, sessionUserId(request));
      return renderPage(
        reply,
        <LaundryPage
          ctx={viewContext(reply)}
          items={items}
          washed={request.query.washed}
        />,
      );
    },
  );

  // "Mark washed": every checked garment of the user's, today; other ids
  // are ignored like unknown ones. Back to the page with the count.
  app.post(
    '/laundry',
    { schema: { body: LaundryBody } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const ids = request.body?.ids ?? [];
      const day = today();
      const washed = await markWashed(db, userId, ids, day);
      logger.info(
        `Laundry by user ${userId} on ${day}: ${washed.length} washed of ${ids.length} checked`,
      );
      return reply.redirect(`/laundry?washed=${washed.length}`, 303);
    },
  );

  done();
};
