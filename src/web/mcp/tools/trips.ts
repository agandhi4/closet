import * as z from 'zod/v4';
import { tripPhase } from '../../../wardrobe/packing';
import { NORMAL_YEARS } from '../../../weather/normals';
import { todayIn } from '../../calendar/calendar-date';
import { HttpError } from '../../errors';
import { OUTFIT_NAME_MAX } from '../../outfits/queries';
import { tripForecast } from '../../trips/forecast';
import { tripModel, type TripOutfitView } from '../../trips/model';
import {
  addTripOutfit,
  findTrip,
  listTrips,
  pickForTrip,
  type TripSlot,
} from '../../trips/queries';
import { tripNotFound } from '../../trips/validation';
import { defineTool, type ToolContext } from '../tool';
import { isoDate, occasionInput, rowId } from './common';
import { dayWeather, typicalDayWeather } from './weather';

/**
 * Trips (#10): the same model the trip page renders (tripModel: its days
 * and outfits, the derived packing list with its warnings, the extras) and
 * the same writers. The caller's own, like outfits: no ownerId.
 */

function outfitOut(outfit: TripOutfitView) {
  return {
    tripOutfitId: outfit.id,
    outfitId: outfit.outfitId,
    name: outfit.name,
    day: outfit.day,
    occasion: outfit.occasion,
    garments: outfit.garments.map((g) => ({
      id: g.id,
      name: g.name,
      category: g.category,
    })),
  };
}

/**
 * plan_trip_outfit's write: a saved outfit (addTripOutfit), or an idea's
 * garments made one (pickForTrip), on the trip; refusals thrown as a route
 * answers them.
 */
async function planOnTrip(
  ctx: ToolContext,
  input: {
    tripId: number;
    outfitId: number | undefined;
    garmentIds: number[] | undefined;
    name: string | undefined;
  } & TripSlot,
): Promise<{ outfitId: number; created: boolean; added: boolean }> {
  const { tripId, day, occasion } = input;
  const outcome =
    input.garmentIds === undefined
      ? await addTripOutfit(ctx.db, {
          tripId,
          ownerId: ctx.userId,
          outfitId: input.outfitId!,
          day,
          occasion,
        })
      : await pickForTrip(ctx.db, ctx.userId, {
          tripId,
          garmentIds: input.garmentIds,
          name: input.name,
          day,
          occasion,
        });
  if (outcome === 'added' || outcome === 'already') {
    return {
      outfitId: input.outfitId!,
      created: false,
      added: outcome === 'added',
    };
  }
  if (typeof outcome === 'string') throw await refusal(ctx, tripId, outcome);
  return {
    outfitId: outcome.outfit.id,
    created: !outcome.outfit.alreadySaved,
    added: outcome.added === 'added',
  };
}

async function refusal(
  ctx: ToolContext,
  tripId: number,
  outcome: 'no-trip' | 'not-a-trip-day' | 'no-outfit' | 'not-found',
): Promise<HttpError> {
  switch (outcome) {
    case 'no-trip':
      return tripNotFound();
    case 'not-a-trip-day': {
      const trip = await findTrip(ctx.db, tripId, ctx.userId);
      return new HttpError(
        400,
        `The date must be a day of the trip, ${trip?.startsOn} to ${trip?.endsOn}`,
      );
    }
    case 'no-outfit':
      return new HttpError(404, 'Outfit not found');
    case 'not-found':
      return new HttpError(404, 'A garment is not in your closet');
  }
}

export const tripTools = [
  defineTool({
    name: 'list_trips',
    title: 'List my trips',
    description:
      'Your trips: upcoming and current first (soonest first), then past ones, each with its dates, destination, phase (upcoming, current, past) and how many outfits and extras it holds. get_trip has the outfits and the packing list.',
    input: z.object({}),
    writes: false,
    async run(_args, ctx) {
      const today = todayIn(ctx.timeZone, new Date());
      const trips = await listTrips(ctx.db, ctx.userId, today);
      return {
        today,
        trips: trips.map((trip) => ({
          id: trip.id,
          name: trip.name,
          destination: trip.destination,
          located: trip.location !== null,
          startsOn: trip.startsOn,
          endsOn: trip.endsOn,
          phase: tripPhase(trip, today),
          outfits: trip.outfits,
          extras: trip.extras,
        })),
      };
    },
  }),

  defineTool({
    name: 'get_trip',
    title: 'Get a trip',
    description: `One of your trips as its page shows it: the days with their outfits (each for a day and an occasion, or for any day), and the packing list, derived from those outfits: every garment grouped by role, how many outfits hold it, its wears on the trip (one per day it is worn, whatever the occasions, plus one per outfit without a day), the copies needed (with a wash limit k, ceil(wears / k) since nothing is washed on the trip; one for what is never washed), the copies to pack (up to the quantity owned), whether it is marked packed, and warnings: too-few (you own fewer than the trip needs), wash (before departure, fewer clean copies now than to pack), away (lent or at the repair shop), archived. A finished trip's list has no warnings. Then the extras (charger, toiletries...) packed or not. With weather on and the destination located in the app, the destination's forecast for the trip's days within the 16-day forecast (forecastUnavailable when Open-Meteo has none for the place yet: typicalDays still come), from when the later days' forecast arrives, and meanwhile those later days' typical weather (typicalDays, each marked typical: the average of the last ${NORMAL_YEARS} years' days around that date at the destination, never a forecast: highs and lows, the feels-like range, the share of days with rain, and what such a day asks of an all-day outfit).`,
    input: z.object({ tripId: rowId().describe('The trip, from list_trips.') }),
    writes: false,
    async run({ tripId }, ctx) {
      const today = todayIn(ctx.timeZone, new Date());
      const model = await tripModel(ctx.db, ctx.userId, tripId, today);
      if (!model) throw tripNotFound();
      const { trip, packing } = model;
      const forecast = ctx.weather
        ? await tripForecast(
            { db: ctx.db, weather: ctx.weather },
            ctx.userId,
            trip,
            today,
          )
        : null;
      return {
        id: trip.id,
        name: trip.name,
        destination: trip.destination,
        located: trip.location !== null,
        startsOn: trip.startsOn,
        endsOn: trip.endsOn,
        notes: trip.notes,
        today,
        phase: model.phase,
        days: model.days.map((day) => ({
          day: day.day,
          outfits: day.outfits.map(outfitOut),
        })),
        anyDay: model.undated.map(outfitOut),
        packing: {
          garments: packing.garments,
          packed: packing.packed,
          pieces: packing.pieces,
          warned: packing.warned,
          groups: packing.groups.map((group) => ({
            role: group.role,
            garments: group.rows.map((row) => ({
              id: row.garment.id,
              name: row.garment.name,
              category: row.garment.category,
              quantity: row.garment.quantity,
              outfits: row.outfits,
              wears: row.wears,
              copiesNeeded: row.needed,
              pack: row.pack,
              packed: row.packed,
              warnings: row.warnings,
            })),
          })),
        },
        extras: model.items.map((item) => ({
          label: item.label,
          packed: item.packed,
        })),
        weather:
          forecast === null
            ? undefined
            : forecast.kind === 'forecast'
              ? {
                  forecastUnavailable: forecast.unavailable,
                  fetchedAt: forecast.fetchedAt?.toISOString() ?? null,
                  days: forecast.days.map((day) =>
                    dayWeather(day.forecast, 'all-day', forecast.offset),
                  ),
                  laterDays: forecast.later && {
                    from: forecast.later.day,
                    forecastArrives: forecast.later.from,
                  },
                  typicalDays: forecast.typical.map(typicalDayWeather),
                }
              : { status: forecast.kind },
      };
    },
  }),

  defineTool({
    name: 'plan_trip_outfit',
    title: 'Add an outfit to a trip',
    description:
      'WRITES: adds an outfit to one of your trips, optionally for one of its days (date) and an occasion: either a saved outfit (outfitId, from list_outfits) or an idea from suggest_outfits (garmentIds: saved as an outfit named after its garments unless you give a name, or reused when you already have one of exactly these garments). Exactly one of the two. The packing list (get_trip) follows. Safe to retry: the same outfit on the same day (or without a day) is on the trip once, and keeps the occasion it has.',
    input: z.object({
      tripId: rowId().describe('The trip, from list_trips.'),
      outfitId: rowId().optional().describe('A saved outfit of yours.'),
      garmentIds: z
        .array(rowId())
        .min(1)
        .max(8)
        .optional()
        .describe("An idea's garmentIds, from suggest_outfits."),
      date: isoDate()
        .optional()
        .describe('One of the trip days (YYYY-MM-DD). Omit for any day.'),
      occasion: occasionInput.describe(
        'The part of the day it is for. Omit when it does not matter.',
      ),
      name: z.string().trim().min(1).max(OUTFIT_NAME_MAX).optional(),
    }),
    writes: true,
    idempotent: true,
    async run({ tripId, outfitId, garmentIds, date, occasion, name }, ctx) {
      if ((outfitId === undefined) === (garmentIds === undefined)) {
        throw new HttpError(400, 'Give either outfitId or garmentIds');
      }
      const planned = await planOnTrip(ctx, {
        tripId,
        outfitId,
        garmentIds,
        name,
        day: date,
        occasion,
      });
      ctx.webLogger.info(
        `Outfit ${planned.outfitId} ${planned.added ? 'added to' : 'already on'} trip ${tripId} by user ${ctx.userId} (MCP; ${date ?? 'any day'}${occasion ? `, ${occasion}` : ''})`,
      );
      return {
        tripId,
        outfitId: planned.outfitId,
        outfitCreated: planned.created,
        added: planned.added,
        day: date ?? null,
        occasion: occasion ?? null,
      };
    },
  }),
];
