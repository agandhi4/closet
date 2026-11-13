import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AWAY_REASONS } from '../../wardrobe/availability';
import { sessionUserId } from '../auth/require-session';
import { AutosaveSaved } from '../autosave';
import { todayIn } from '../../calendar-date';
import type { WebOptions } from '../plugin';
import { renderFragment, renderPage } from '../render';
import {
  answerReplay,
  isReplay,
  replayNote,
  requestedDay,
} from '../offline-writes';
import { GarmentParams, IsoDateSchema, OwnerQuery, RowId } from '../schemas';
import { actorOf, sharedWardrobesOf } from '../sharing/access';
import { viewContext } from '../view-context';
import { garmentAddress, garmentNotFound } from '../wardrobe/garment-access';
import { garmentUrl, LAUNDRY_PATH } from '../wardrobe/urls';
import { CARE_NOTE_MAX } from '../wardrobe/garment-input';
import { LaundryPage } from './laundry-page';
import { laundryList, markWashed, wearStatusOf } from './queries';
import { putGarmentAway, washGarment, wearGarment } from './wear-actions';
import { WearStatus } from './wear-section';

// `day` is a queued tap's own day (#178), else today: requestedDay
// refuses one outside the replay window (409).
const WoreTodayBody = Type.Object({
  worn: Type.Union([Type.Literal('1'), Type.Literal('0')]),
  day: Type.Optional(IsoDateSchema),
  // The queued create's id (the outbox record's). Accepted and unused
  // until garment_wear.client_id lands with #196a-2; the (garment, day)
  // unique index already makes a retried wear a no-op.
  clientId: Type.Optional(Type.String({ format: 'uuid' })),
});

const WashedBody = Type.Union([
  Type.Object({ day: Type.Optional(IsoDateSchema) }),
  Type.Null(),
]);

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
   * A replay's 204 (src/web/offline-writes.ts); the wear status again to
   * htmx; the garment page to a plain post.
   */
  async function answer(
    request: FastifyRequest,
    reply: FastifyReply,
    write: { id: number; ownerId: number; changed: boolean },
  ): Promise<FastifyReply> {
    const { id, ownerId } = write;
    if (isReplay(request)) return answerReplay(reply, write.changed);
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

  // Wore today (worn=1) and its undo the same day (worn=0). Queueable
  // (#178): last write wins, so a replayed undo after a wear unwears.
  app.post(
    '/wardrobe/:id/wear',
    {
      config: { queueable: 'wear' },
      schema: {
        params: GarmentParams,
        querystring: OwnerQuery,
        body: WoreTodayBody,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const worn = request.body.worn === '1';
      const day = requestedDay(reply, request.body.day, today());
      const { ownerId, changed } = await wearGarment(
        db,
        actorOf(request),
        garmentAddress(request),
        { day, worn },
      );
      logger.info(
        `Garment ${id} ${worn ? 'worn' : 'wear undone'} on ${day} by user ${ownerId}${changed ? '' : ', already so'}${replayNote(request)}`,
      );
      return answer(request, reply, { id, ownerId, changed });
    },
  );

  // Queueable (#178); a wash only moves forward (markWashed), so a late
  // replay of an older one is `unchanged`.
  app.post(
    '/wardrobe/:id/washed',
    {
      config: { queueable: 'wash' },
      schema: {
        params: GarmentParams,
        querystring: OwnerQuery,
        body: WashedBody,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const day = requestedDay(reply, request.body?.day, today());
      const { ownerId, changed } = await washGarment(
        db,
        actorOf(request),
        garmentAddress(request),
        day,
      );
      logger.info(
        `Garment ${id} washed on ${day} by user ${ownerId}${changed ? '' : ', already washed then or later'}${replayNote(request)}`,
      );
      return answer(request, reply, { id, ownerId, changed });
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
      const { away, awayNote } = request.body;
      const { ownerId } = await putGarmentAway(
        db,
        actorOf(request),
        garmentAddress(request),
        away === '' ? null : { reason: away, note: awayNote?.trim() || null },
      );
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
