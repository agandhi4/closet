import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { type Static, Type } from '@sinclair/typebox';
import { todayIn } from '../../calendar-date';
import { apiResponses } from '../api/contract';
import type { ApiOptions } from '../api/plugin';
import { refusedBody } from '../api/refused-body';
import {
  ListCursor,
  ListLimit,
  ListOf,
  offsetCursor,
  readOffsetCursor,
} from '../api/resource';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { RowId } from '../schemas';
import { type Actor, actorOf } from '../sharing/access';
import { API_PREFIX } from '../surface';
import { createTrip, listTrips } from './queries';
import {
  addTripItem,
  copyTripExtras,
  editTrip,
  pickIdeaForTrip,
  planTripOutfit,
  removeTrip,
  removeTripExtra,
  requireTripModel,
  requireTrip,
  takeOffTrip,
  tickTripGarment,
  tickTripItem,
  wearTripOutfit,
} from './trip-actions';
import {
  GarmentPacked,
  ItemPacked,
  NewTrip,
  NewTripItem,
  PackedInput,
  POINTER_OF_TRIP_FIELD,
  Trip,
  TripCreated,
  TripInput,
  TripItemAdded,
  TripItemsCopied,
  TripItemsCopy,
  TripListItem,
  TripOutfitAddedResource,
  TripOutfitInput,
  TripOutfitRemoved,
  TripOutfitWorn,
  TripUpdated,
  toTripListItem,
  toTripResource,
} from './trip-resource';
import {
  readTripForm,
  TripItemParams,
  TripOutfitParams,
  TripParams,
} from './validation';

/** A page of GET /trips unless asked: more trips than most households keep. */
const TRIP_PAGE_SIZE = 50;

const TripListQuery = Type.Object({
  cursor: Type.Optional(ListCursor),
  limit: ListLimit(TRIP_PAGE_SIZE),
});

const TripList = ListOf(TripListItem, {
  title: 'TripList',
  description:
    'A page of your trips: those not over yet first, soonest first, then the past ones, latest first',
});

const TripPackingParams = Type.Object({ id: RowId, garmentId: RowId });

const TRIP_PATH = '/trips/:id';
const TRIP_OUTFIT_PATH = `${TRIP_PATH}/outfits/:tripOutfitId`;
const TRIP_ITEM_PATH = `${TRIP_PATH}/items/:itemId`;

const deleted = { 204: Type.Null({ description: 'Deleted' }) };

/** POST /trips/{id}/outfits names neither an outfit nor garments, or both. */
function outfitOrGarments(): HttpError {
  const message = t('api.TRIP_OUTFIT_ONE_OF');
  return new HttpError(400, message, {
    validation: [{ path: 'body/outfitId', message }],
  });
}

/**
 * Trips and packing on /api/v1 (#194a; plan section 6), registered by
 * apiPlugin, each calling what its page twin calls (operations.ts names the
 * twin): trip-actions.ts for one trip, listTrips and createTrip for the
 * list and a new one. Trips are private (src/web/trips/AGENTS.md): only the
 * token's user's own are reached, there is no `?ownerId=`, and another's
 * trip, trip outfit or extra is the 404 of an unknown id. The ticks are
 * set-state per garment and per extra, so a queued retry is a no-op.
 */
export const tripApiRoutes: FastifyPluginCallbackTypebox<ApiOptions> = (
  app,
  { db, config, logger },
  done,
) => {
  const today = () => todayIn(config.timeZone, new Date());

  /**
   * plan_trip_outfit's two paths, as the MCP tool takes them: a saved
   * outfit (planTripOutfit) or an idea's garments made one
   * (pickIdeaForTrip), each refusing itself.
   */
  async function planOnTrip(
    actor: Actor,
    tripId: number,
    input: Static<typeof TripOutfitInput>,
  ): Promise<Static<typeof TripOutfitAddedResource>> {
    const { outfitId, garmentIds, day, occasion } = input;
    const slot = { tripId, day, occasion };
    if (garmentIds === undefined) {
      if (outfitId === undefined) throw outfitOrGarments();
      const outcome = await planTripOutfit(db, actor, { ...slot, outfitId });
      return { outfitId, outfitCreated: false, added: outcome === 'added' };
    }
    if (outfitId !== undefined) throw outfitOrGarments();
    const picked = await pickIdeaForTrip(db, actor, {
      ...slot,
      garmentIds,
      name: input.name?.trim() || undefined,
    });
    return {
      outfitId: picked.outfit.id,
      outfitCreated: !picked.outfit.alreadySaved,
      added: picked.added === 'added',
    };
  }

  app.get(
    '/trips',
    {
      schema: {
        operationId: 'listTrips',
        tags: ['trips'],
        summary: 'Your trips, upcoming first',
        description:
          'Each with its dates, destination, phase and how many outfits and extras it holds. The order moves with the day (a trip ending yesterday is past), so read the list from its first page.',
        querystring: TripListQuery,
        response: apiResponses({ 200: TripList }),
      },
    },
    async (request) => {
      const { cursor, limit = TRIP_PAGE_SIZE } = request.query;
      const offset = cursor === undefined ? 0 : readOffsetCursor(cursor);
      const day = today();
      // One more than the page: whether another follows.
      const trips = await listTrips(db, actorOf(request).userId, day, {
        offset,
        limit: limit + 1,
      });
      const more = trips.length > limit;
      return {
        data: trips.slice(0, limit).map((trip) => toTripListItem(trip, day)),
        pagination: {
          ...(more && { nextCursor: offsetCursor(offset + limit) }),
          limit,
        },
      };
    },
  );

  app.get(
    TRIP_PATH,
    {
      schema: {
        operationId: 'getTrip',
        tags: ['trips'],
        summary: 'One of your trips, with its outfits and packing list',
        description:
          "Its days with their outfits, the outfits for any day, the packing list derived from them (copies needed, packed marks, warnings while the trip is ahead or on) and the extras. Another's trip is a 404 like an unknown id.",
        params: TripParams,
        response: apiResponses({ 200: Trip }),
      },
    },
    async (request) =>
      toTripResource(
        await requireTripModel(
          db,
          actorOf(request),
          request.params.id,
          today(),
        ),
      ),
  );

  app.post(
    '/trips',
    {
      schema: {
        operationId: 'createTrip',
        tags: ['trips'],
        summary: 'Creates a trip',
        description:
          'Judged as the trip form is: a blank name, an end before the start or more than 60 days is a 400 naming the field. 201 with its `Location`.',
        body: NewTrip,
        response: apiResponses({ 201: TripCreated }),
      },
    },
    async (request, reply) => {
      const userId = actorOf(request).userId;
      const { clientId, ...fields } = request.body;
      const form = readTripForm(fields);
      if (!form.ok) throw refusedBody(form.errors, POINTER_OF_TRIP_FIELD);
      const id = await createTrip(db, userId, form.fields);
      logger.info(
        `Trip ${id} created by user ${userId} (API): ${form.fields.startsOn} to ${form.fields.endsOn}${clientId ? `, client id ${clientId.slice(0, 8)}` : ''}`,
      );
      return reply
        .status(201)
        .header('Location', `${API_PREFIX}/trips/${id}`)
        .send({ id });
    },
  );

  app.put(
    TRIP_PATH,
    {
      schema: {
        operationId: 'updateTrip',
        tags: ['trips'],
        summary: "Replaces a trip's name, destination, dates and notes",
        description:
          "The trip form's save: every field is sent (one left out is cleared), judged as on create. Outfits on days the new dates leave out move to any day; a new destination forgets the located place.",
        params: TripParams,
        body: TripInput,
        response: apiResponses({ 200: TripUpdated }),
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id } = request.params;
      const form = readTripForm(request.body);
      if (!form.ok) {
        // As the page: another's trip is a 404 whatever was sent.
        await requireTrip(db, actor, id);
        throw refusedBody(form.errors, POINTER_OF_TRIP_FIELD);
      }
      const saved = await editTrip(db, actor, id, form.fields);
      logger.info(
        `Trip ${id} updated by user ${actor.userId} (API): ${form.fields.startsOn} to ${form.fields.endsOn}${saved.undated > 0 ? `, ${saved.undated} outfit(s) moved to any day` : ''}${saved.locationCleared ? ', destination location cleared' : ''}`,
      );
      return saved;
    },
  );

  app.delete(
    TRIP_PATH,
    {
      schema: {
        operationId: 'deleteTrip',
        tags: ['trips'],
        summary: 'Deletes a trip',
        description:
          'Its outfits stay (they are yours, apart from the trip); its extras and packed marks go. A trip already gone is a 404, which a retry may read as done.',
        params: TripParams,
        response: apiResponses(deleted),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id } = request.params;
      await removeTrip(db, actor, id);
      logger.info(`Trip ${id} deleted by user ${actor.userId} (API)`);
      return reply.status(204).send(null);
    },
  );

  // ---- Outfits ----------------------------------------------------------------

  app.post(
    `${TRIP_PATH}/outfits`,
    {
      schema: {
        operationId: 'addTripOutfit',
        tags: ['trips'],
        summary: 'Adds an outfit to a trip',
        description:
          "A saved outfit (`outfitId`), or an idea's garments (`garmentIds`, saved as an outfit or the one you have of exactly these), for a day of the trip and an occasion, or for any day. 201 when added, 200 `added: false` when it was on that day already (a retry). GET /trips/{id} then lists it and the packing list it changes.",
        params: TripParams,
        body: TripOutfitInput,
        response: apiResponses({
          200: TripOutfitAddedResource,
          201: TripOutfitAddedResource,
        }),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id } = request.params;
      const { day, occasion } = request.body;
      const planned = await planOnTrip(actor, id, request.body);
      logger.info(
        `Outfit ${planned.outfitId}${planned.outfitCreated ? ' (new)' : ''} ${planned.added ? 'added to' : 'already on'} trip ${id} by user ${actor.userId} (API; ${day ?? 'any day'}${occasion ? `, ${occasion}` : ''})`,
      );
      return reply.status(planned.added ? 201 : 200).send(planned);
    },
  );

  app.delete(
    TRIP_OUTFIT_PATH,
    {
      schema: {
        operationId: 'removeTripOutfit',
        tags: ['trips'],
        summary: 'Takes an outfit off a trip',
        description:
          'The outfit itself stays. Garments no other outfit of the trip holds leave the packing list with their packed marks. One already off is a 404.',
        params: TripOutfitParams,
        response: apiResponses({ 200: TripOutfitRemoved }),
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id, tripOutfitId } = request.params;
      const removed = await takeOffTrip(db, actor, {
        tripId: id,
        tripOutfitId,
      });
      logger.info(
        `Outfit ${removed.outfitId} taken off trip ${id} by user ${actor.userId} (API; trip outfit ${tripOutfitId}; ${removed.unpacked} packed mark(s) removed with its garments)`,
      );
      return removed;
    },
  );

  app.post(
    `${TRIP_OUTFIT_PATH}/wears`,
    {
      schema: {
        operationId: 'wearTripOutfit',
        tags: ['trips'],
        summary: 'Wore it today: a trip\'s "Wore it"',
        description:
          "Planned on today's calendar for its occasion (all day without one) and marked worn there, once: a repeat is `changed: false`. Only while the trip is on, and only an outfit for today or for any day; else a 409.",
        params: TripOutfitParams,
        response: apiResponses({ 200: TripOutfitWorn }),
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id, tripOutfitId } = request.params;
      const at = new Date();
      const day = todayIn(config.timeZone, at);
      const wore = await wearTripOutfit(
        db,
        actor,
        { tripId: id, tripOutfitId },
        { at, today: day },
      );
      const { entryId, scheduled, worn } = wore.worn;
      logger.info(
        `Trip ${id} outfit ${wore.outfitId} worn by user ${actor.userId} on ${day} (${wore.occasion}; API): entry ${entryId} ${scheduled === 'scheduled' ? 'planned' : 'already planned'}, ${worn.changed ? `marked worn (${worn.wears} wears logged)` : 'already worn'}`,
      );
      return {
        outfitId: wore.outfitId,
        day,
        occasion: wore.occasion,
        entryId,
        changed: worn.changed,
      };
    },
  );

  // ---- Packing ----------------------------------------------------------------

  app.put(
    `${TRIP_PATH}/packing/:garmentId`,
    {
      schema: {
        operationId: 'setTripGarmentPacked',
        tags: ['trips'],
        summary: 'Ticks a garment on the packing list, or unticks it',
        description:
          'Set-state: a repeat is `changed: false`. A garment the list does not hold (no outfit of the trip has it, or it just left with one) is a 404, which a queued tick may drop.',
        params: TripPackingParams,
        body: PackedInput,
        response: apiResponses({ 200: GarmentPacked }),
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id, garmentId } = request.params;
      const { packed } = request.body;
      const { changed } = await tickTripGarment(db, actor, {
        tripId: id,
        garmentId,
        packed,
      });
      logger.info(
        `Trip ${id} packing set by user ${actor.userId} (API): garment ${garmentId} ${packed ? 'packed' : 'unpacked'}${changed ? '' : ', already so'}`,
      );
      return { garmentId, packed, changed };
    },
  );

  // ---- Extras -----------------------------------------------------------------

  app.post(
    `${TRIP_PATH}/items`,
    {
      schema: {
        operationId: 'addTripItem',
        tags: ['trips'],
        summary: 'Adds an extra to pack',
        description:
          'Unpacked. 201 when added, 200 `added: false` when the trip has that label already, in any case (a retry). GET /trips/{id} lists it with its id.',
        params: TripParams,
        body: NewTripItem,
        response: apiResponses({ 200: TripItemAdded, 201: TripItemAdded }),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id } = request.params;
      const added = (await addTripItem(db, actor, id, request.body.label)) > 0;
      logger.info(
        `Trip ${id} extra ${added ? 'added' : 'already there'} by user ${actor.userId} (API)`,
      );
      return reply.status(added ? 201 : 200).send({ added });
    },
  );

  app.patch(
    TRIP_ITEM_PATH,
    {
      schema: {
        operationId: 'setTripItemPacked',
        tags: ['trips'],
        summary: 'Ticks an extra, or unticks it',
        description:
          'Set-state: a repeat is `changed: false`. An extra removed meanwhile is a 404, which a queued tick may drop.',
        params: TripItemParams,
        body: PackedInput,
        response: apiResponses({ 200: ItemPacked }),
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id, itemId } = request.params;
      const { packed } = request.body;
      const { item, changed } = await tickTripItem(db, actor, {
        tripId: id,
        itemId,
        packed,
      });
      logger.info(
        `Trip ${id} extras set by user ${actor.userId} (API): extra ${itemId} ${packed ? 'packed' : 'unpacked'}${changed ? '' : ', already so'}`,
      );
      return { ...item, changed };
    },
  );

  app.delete(
    TRIP_ITEM_PATH,
    {
      schema: {
        operationId: 'removeTripItem',
        tags: ['trips'],
        summary: 'Removes an extra',
        description:
          'One already gone is a 404, which a retry may read as done.',
        params: TripItemParams,
        response: apiResponses(deleted),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id, itemId } = request.params;
      await removeTripExtra(db, actor, { tripId: id, itemId });
      logger.info(
        `Trip ${id} extra ${itemId} removed by user ${actor.userId} (API)`,
      );
      return reply.status(204).send(null);
    },
  );

  app.post(
    `${TRIP_PATH}/items/copies`,
    {
      schema: {
        operationId: 'copyTripItems',
        tags: ['trips'],
        summary: "Copies another trip's extras",
        description:
          'Its labels, unpacked, in its order; those this trip has already are skipped, so a retry adds none. Both trips yours, and not the same one, else a 404.',
        params: TripParams,
        body: TripItemsCopy,
        response: apiResponses({ 200: TripItemsCopied }),
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id } = request.params;
      const { fromTripId } = request.body;
      const added = await copyTripExtras(db, actor, {
        fromTripId,
        toTripId: id,
      });
      logger.info(
        `Trip ${id}: ${added} extra(s) copied from trip ${fromTripId} by user ${actor.userId} (API)`,
      );
      return { added };
    },
  );

  done();
};
