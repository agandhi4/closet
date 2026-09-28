import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyReply } from 'fastify';
import {
  DEFAULT_OCCASION,
  isOccasion,
  type Occasion,
} from '../../wardrobe/occasions';
import { tripPhase, wearableToday } from '../../wardrobe/packing';
import { roundedLocation } from '../../weather/location';
import { sessionUserId } from '../auth/require-session';
import { AutosaveSaved } from '../autosave';
import { addDays, parseIsoDate, todayIn } from '../calendar/calendar-date';
import { wearOutfitOn } from '../calendar/queries';
import { unchecked } from '../capsules/validation';
import { HttpError } from '../errors';
import { listOutfits } from '../outfits/queries';
import type { WebOptions } from '../plugin';
import { navigateTo, renderFragment, renderPage } from '../render';
import {
  WEATHER_LOCATION_LIMIT,
  WEATHER_SEARCH_LIMIT,
} from '../security/rate-limit';
import { viewContext } from '../view-context';
import { AddOutfitPage } from './add-page';
import { tripForecast } from './forecast';
import { TripFormPage, type TripFormModel } from './form-page';
import { TripsPage } from './list-page';
import { tripModel } from './model';
import { setPacked } from './packed';
import {
  addTripItems,
  addTripOutfit,
  copyTripItems,
  createTrip,
  deleteTrip,
  findTrip,
  findTripOutfit,
  listTrips,
  outfitsOnTripDay,
  removeTripItem,
  removeTripOutfit,
  setItemsPacked,
  setTripDestination,
  tripDays,
  tripItems,
  tripsWithItems,
  updateTrip,
} from './queries';
import { ItemsSummary, PackedSummary, TripPage } from './trip-page';
import { dayAnchor, TRIPS_PATH, tripUrl } from './urls';
import {
  AddOutfitBody,
  AddOutfitQuery,
  ChecklistBody,
  CopyItemsBody,
  DestinationBody,
  ItemBody,
  readTripForm,
  type TripBody,
  TripBody as TripBodySchema,
  type TripForm,
  TripItemParams,
  TripOutfitParams,
  TripPageQuery,
  TripParams,
  tripNotFound,
} from './validation';
import { TripPlaceResults, TripWeather } from './weather';

/**
 * Trips (#10; plan section 4): the Calendar's Trips tab and every trip
 * write. The owner's own, like outfits: `?ownerId=` is not read, another
 * user's trip, trip outfit or extra is a 404 like an unknown id, and shares
 * never reach them (matrix rows in test/integration/authorization-trips.spec.ts).
 *
 * Validation, decided per parameter:
 * - The trip form's fields are data it stores: past their caps a 400 page,
 *   a blank name or a bad date range the form again with messages (400,
 *   a native post).
 * - The add page's `?day=` and `?occasion=` are navigation state: anything
 *   that is not one of the trip's days, or an occasion, is none.
 * - Every other write posts ids and values the pages built: malformed is a
 *   400, a day outside the trip a 400 too (the writer's refusal), anything
 *   not the owner's a 404 with nothing written.
 * - The weather routes (the forecast fragment, the place search, setting
 *   the located destination) exist only with WEATHER_ENABLED, like
 *   /weather/*; the search is rate limited and its query never logged.
 */
export const tripRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { db, config, logger, weather },
  done,
) => {
  const today = () => todayIn(config.timeZone, new Date());

  function renderForm(
    reply: FastifyReply,
    model: TripFormModel,
    status = 200,
  ): Promise<FastifyReply> {
    return renderPage(
      reply,
      <TripFormPage ctx={viewContext(reply)} model={model} />,
      { status },
    );
  }

  function refuseForm(
    reply: FastifyReply,
    refused: TripForm & { ok: false },
    tripId?: number,
  ): Promise<FastifyReply> {
    logger.warn(
      `Trip form refused (${tripId === undefined ? 'new' : `trip ${tripId}`}): ${Object.keys(refused.errors).join(', ')}`,
    );
    return renderForm(
      reply,
      { tripId, values: formValues(refused.values), errors: refused.errors },
      400,
    );
  }

  /** Back to the trip's page (a section of it) after a plain post. */
  function backToTrip(reply: FastifyReply, tripId: number, anchor?: string) {
    return reply.redirect(
      `${tripUrl(tripId)}${anchor ? `#${anchor}` : ''}`,
      303,
    );
  }

  app.get(TRIPS_PATH, async (request, reply) => {
    const ownerId = sessionUserId(request);
    const day = today();
    const trips = await listTrips(db, ownerId, day);
    return renderPage(
      reply,
      <TripsPage ctx={viewContext(reply)} trips={trips} today={day} />,
    );
  });

  app.get(`${TRIPS_PATH}/new`, async (_request, reply) => {
    // A week from tomorrow, a common first guess the date inputs then move.
    const starts = addDays(today(), 1);
    return renderForm(reply, {
      values: {
        name: '',
        destination: '',
        startsOn: starts,
        endsOn: addDays(starts, 2),
        notes: '',
      },
    });
  });

  app.post(
    TRIPS_PATH,
    { schema: { body: TripBodySchema } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const form = readTripForm(request.body);
      if (!form.ok) return refuseForm(reply, form);
      const id = await createTrip(db, ownerId, form.fields);
      logger.info(
        `Trip ${id} created by user ${ownerId}: ${form.fields.startsOn} to ${form.fields.endsOn}`,
      );
      return reply.redirect(tripUrl(id, '?created=1'), 303);
    },
  );

  app.get(
    `${TRIPS_PATH}/:id`,
    { schema: { params: TripParams, querystring: TripPageQuery } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const { id } = request.params;
      const started = performance.now();
      const model = await tripModel(db, ownerId, id, today());
      if (!model) throw tripNotFound();
      const copyFrom = await tripsWithItems(db, ownerId, id);
      logger.debug(
        `Trip ${id} for user ${ownerId}: ${model.days.length} day(s), ${model.packing.garments} garment(s) to pack (${model.packing.packed} packed, ${model.packing.warned} warned), ${model.items.length} extra(s) in ${Math.round(performance.now() - started)} ms`,
      );
      return renderPage(
        reply,
        <TripPage
          ctx={viewContext(reply)}
          model={{
            ...model,
            copyFrom,
            created: request.query.created === '1',
            picked: request.query.picked === '1',
            copied: request.query.copied,
          }}
        />,
      );
    },
  );

  app.get(
    `${TRIPS_PATH}/:id/edit`,
    { schema: { params: TripParams } },
    async (request, reply) => {
      const { id } = request.params;
      const trip = await findTrip(db, id, sessionUserId(request));
      if (!trip) throw tripNotFound();
      return renderForm(reply, {
        tripId: id,
        values: {
          name: trip.name,
          destination: trip.destination ?? '',
          startsOn: trip.startsOn,
          endsOn: trip.endsOn,
          notes: trip.notes ?? '',
        },
      });
    },
  );

  app.post(
    `${TRIPS_PATH}/:id`,
    { schema: { params: TripParams, body: TripBodySchema } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const { id } = request.params;
      if (!(await findTrip(db, id, ownerId))) throw tripNotFound();
      const form = readTripForm(request.body);
      if (!form.ok) return refuseForm(reply, form, id);
      const saved = await updateTrip(db, id, ownerId, form.fields);
      if (saved === 'not-found') throw tripNotFound();
      logger.info(
        `Trip ${id} updated by user ${ownerId}: ${form.fields.startsOn} to ${form.fields.endsOn}${saved.undated > 0 ? `, ${saved.undated} outfit(s) moved to any day` : ''}${saved.locationCleared ? ', destination location cleared' : ''}`,
      );
      return backToTrip(reply, id);
    },
  );

  // htmx (hx-delete, hx-confirm): the outfits stay.
  app.delete(
    `${TRIPS_PATH}/:id`,
    { schema: { params: TripParams } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const { id } = request.params;
      if (!(await deleteTrip(db, id, ownerId))) throw tripNotFound();
      logger.info(`Trip ${id} deleted by user ${ownerId}`);
      return navigateTo(reply, TRIPS_PATH);
    },
  );

  // ---- Outfits ----------------------------------------------------------------

  app.get(
    `${TRIPS_PATH}/:id/outfits/new`,
    { schema: { params: TripParams, querystring: AddOutfitQuery } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const { id } = request.params;
      const trip = await findTrip(db, id, ownerId);
      if (!trip) throw tripNotFound();
      const days = tripDays(trip);
      const asked = parseIsoDate(request.query.day);
      const day = asked && days.includes(asked) ? asked : undefined;
      const occasion =
        request.query.occasion !== undefined &&
        isOccasion(request.query.occasion)
          ? request.query.occasion
          : undefined;
      const [outfits, onTrip] = await Promise.all([
        listOutfits(db, ownerId),
        outfitsOnTripDay(db, id, day ?? null),
      ]);
      return renderPage(
        reply,
        <AddOutfitPage
          ctx={viewContext(reply)}
          model={{
            trip,
            days,
            day,
            occasion,
            outfits,
            onTrip,
          }}
        />,
      );
    },
  );

  app.post(
    `${TRIPS_PATH}/:id/outfits`,
    { schema: { params: TripParams, body: AddOutfitBody } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const { id } = request.params;
      const { outfitId } = request.body;
      const day = request.body.day || undefined;
      const occasion: Occasion | undefined = request.body.occasion || undefined;
      const outcome = await addTripOutfit(db, {
        tripId: id,
        ownerId,
        outfitId,
        day,
        occasion,
      });
      if (outcome === 'no-trip') throw tripNotFound();
      if (outcome === 'no-outfit') throw new HttpError(404, 'Outfit not found');
      if (outcome === 'not-a-trip-day') {
        throw new HttpError(400, 'body/day must be a day of the trip');
      }
      logger.info(
        `Outfit ${outfitId} ${outcome === 'added' ? 'added to' : 'already on'} trip ${id} by user ${ownerId} (${day ?? 'any day'}${occasion ? `, ${occasion}` : ''})`,
      );
      return backToTrip(reply, id, dayAnchor(day ?? null));
    },
  );

  app.post(
    `${TRIPS_PATH}/:id/outfits/:tripOutfitId/delete`,
    { schema: { params: TripOutfitParams } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const { id, tripOutfitId } = request.params;
      const outcome = await removeTripOutfit(db, {
        tripId: id,
        tripOutfitId,
        ownerId,
      });
      if (outcome === 'not-found') throw tripNotFound();
      logger.info(
        `Outfit ${outcome.outfitId} taken off trip ${id} by user ${ownerId} (trip outfit ${tripOutfitId}; ${outcome.unpacked} packed mark(s) removed with its garments)`,
      );
      return backToTrip(reply, id);
    },
  );

  // "Wearing this today": through the calendar's writers (wearOutfitOn:
  // planned today and marked worn, once), so the calendar stays the one
  // history of what was worn. Only while the trip is on, and only an
  // outfit for today or for no day (wearableToday); else 409.
  app.post(
    `${TRIPS_PATH}/:id/outfits/:tripOutfitId/wear`,
    { schema: { params: TripOutfitParams } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const { id, tripOutfitId } = request.params;
      const found = await findTripOutfit(db, {
        tripId: id,
        tripOutfitId,
        ownerId,
      });
      if (!found) throw tripNotFound();
      const now = new Date();
      const day = todayIn(config.timeZone, now);
      // The page offers the button by the same rule, but a page left open
      // past midnight still shows yesterday's.
      if (!wearableToday(found.trip, found.day, day)) {
        throw new HttpError(
          409,
          tripPhase(found.trip, day) === 'current'
            ? 'This outfit is for another day of the trip'
            : 'The trip is not on today',
          {
            logDetail: `outfit ${found.outfitId} for ${found.day ?? 'any day'} of ${found.trip.startsOn} to ${found.trip.endsOn}, today ${day}`,
          },
        );
      }
      const occasion = found.occasion ?? DEFAULT_OCCASION;
      const outcome = await wearOutfitOn(db, {
        ownerId,
        outfitId: found.outfitId,
        day,
        occasion,
        at: now,
        today: day,
      });
      // The day is today, never after it.
      if (outcome === 'future') throw new Error('Today is after today');
      logger.info(
        `Trip ${id} outfit ${found.outfitId} worn by user ${ownerId} on ${day} (${occasion}): entry ${outcome.entryId} ${outcome.scheduled === 'scheduled' ? 'planned' : 'already planned'}, ${outcome.worn.changed ? `marked worn (${outcome.worn.wears} wears logged)` : 'already worn'}`,
      );
      return backToTrip(reply, id, dayAnchor(found.day));
    },
  );

  // ---- Packing ----------------------------------------------------------------

  // The packing list's AutosaveForm: the status line and the summary out of
  // band; a plain post comes back to the list.
  app.post(
    `${TRIPS_PATH}/:id/packed`,
    { schema: { params: TripParams, body: ChecklistBody } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const { id } = request.params;
      const { packed = [], shown } = request.body ?? {};
      const change = await setPacked(db, {
        tripId: id,
        ownerId,
        packed,
        unpacked: unchecked(shown, packed),
      });
      if (change === 'not-found') throw tripNotFound();
      logger.info(
        `Trip ${id} packing set by user ${ownerId}: ${change.packed} packed, ${change.unpacked} unpacked`,
      );
      if (!request.headers['hx-request']) return backToTrip(reply, id);
      const model = await tripModel(db, ownerId, id, today());
      return renderFragment(
        reply,
        <>
          <AutosaveSaved />
          {model && <PackedSummary packing={model.packing} oob />}
        </>,
      );
    },
  );

  // ---- Extras -----------------------------------------------------------------

  app.post(
    `${TRIPS_PATH}/:id/items`,
    { schema: { params: TripParams, body: ItemBody } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const { id } = request.params;
      const added = await addTripItems(db, id, ownerId, [request.body.label]);
      if (added === 'not-found') throw tripNotFound();
      logger.info(
        `Trip ${id} extra ${added > 0 ? 'added' : 'already there'} by user ${ownerId}`,
      );
      return backToTrip(reply, id, 'extras');
    },
  );

  app.post(
    `${TRIPS_PATH}/:id/items/packed`,
    { schema: { params: TripParams, body: ChecklistBody } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const { id } = request.params;
      const { packed = [], shown } = request.body ?? {};
      const change = await setItemsPacked(db, {
        tripId: id,
        ownerId,
        packed,
        unpacked: unchecked(shown, packed),
      });
      if (change === 'not-found') throw tripNotFound();
      logger.info(
        `Trip ${id} extras set by user ${ownerId}: ${change.packed} packed, ${change.unpacked} unpacked`,
      );
      if (!request.headers['hx-request']) {
        return backToTrip(reply, id, 'extras');
      }
      return renderFragment(
        reply,
        <>
          <AutosaveSaved />
          <ItemsSummary items={await tripItems(db, id)} oob />
        </>,
      );
    },
  );

  app.post(
    `${TRIPS_PATH}/:id/items/:itemId/delete`,
    { schema: { params: TripItemParams } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const { id, itemId } = request.params;
      if (!(await removeTripItem(db, { tripId: id, itemId, ownerId }))) {
        throw tripNotFound();
      }
      logger.info(`Trip ${id} extra ${itemId} removed by user ${ownerId}`);
      return backToTrip(reply, id, 'extras');
    },
  );

  app.post(
    `${TRIPS_PATH}/:id/items/copy`,
    { schema: { params: TripParams, body: CopyItemsBody } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const { id } = request.params;
      const { from } = request.body;
      const copied = await copyTripItems(db, {
        fromTripId: from,
        toTripId: id,
        ownerId,
      });
      if (copied === 'not-found') throw tripNotFound();
      logger.info(
        `Trip ${id}: ${copied} extra(s) copied from trip ${from} by user ${ownerId}`,
      );
      return reply.redirect(tripUrl(id, `?copied=${copied}#extras`), 303);
    },
  );

  // ---- The destination's weather (WEATHER_ENABLED only) ---------------------------

  if (weather) {
    // Always a fragment: the trip page loads it in place.
    app.get(
      `${TRIPS_PATH}/:id/weather`,
      { schema: { params: TripParams } },
      async (request, reply) => {
        const ownerId = sessionUserId(request);
        const trip = await findTrip(db, request.params.id, ownerId);
        if (!trip) throw tripNotFound();
        const now = new Date();
        const forecast = await tripForecast(
          { db, weather },
          ownerId,
          trip,
          todayIn(config.timeZone, now),
        );
        return renderFragment(
          reply,
          <TripWeather
            tripId={trip.id}
            forecast={forecast}
            timeZone={config.timeZone}
            now={now}
          />,
        );
      },
    );

    app.get(
      `${TRIPS_PATH}/:id/places`,
      {
        schema: {
          params: TripParams,
          querystring: Type.Object({
            q: Type.String({ minLength: 2, maxLength: 100 }),
          }),
        },
        config: { rateLimit: WEATHER_SEARCH_LIMIT, secretPath: true },
      },
      async (request, reply) => {
        const { id } = request.params;
        if (!(await findTrip(db, id, sessionUserId(request)))) {
          throw tripNotFound();
        }
        try {
          const places = await weather.searchPlaces(request.query.q.trim());
          return renderFragment(
            reply,
            <TripPlaceResults tripId={id} places={places} />,
          );
        } catch {
          // Logged by the service. A 200, so htmx shows it.
          return renderFragment(reply, <TripPlaceResults failed />);
        }
      },
    );

    app.post(
      `${TRIPS_PATH}/:id/destination`,
      {
        schema: { params: TripParams, body: DestinationBody },
        config: { rateLimit: WEATHER_LOCATION_LIMIT },
      },
      async (request, reply) => {
        const ownerId = sessionUserId(request);
        const { id } = request.params;
        const { name, latitude, longitude } = request.body;
        const set = await setTripDestination(db, id, ownerId, {
          name: name.trim(),
          // In range by the schema, so never null.
          location: roundedLocation(latitude, longitude)!,
        });
        if (!set) throw tripNotFound();
        // The user, never the place: where someone travels is theirs.
        logger.info(`Trip ${id} destination located by user ${ownerId}`);
        return backToTrip(reply, id);
      },
    );
  }

  done();
};

/** A refused post's values, as the form shows them again. */
function formValues(body: TripBody): TripFormModel['values'] {
  return {
    name: body.name,
    destination: body.destination ?? '',
    startsOn: body.startsOn,
    endsOn: body.endsOn,
    notes: body.notes ?? '',
  };
}
