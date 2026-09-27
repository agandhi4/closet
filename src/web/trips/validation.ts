import { type Static, Type } from '@sinclair/typebox';
import type { FieldErrors } from '../auth/validation';
import { daysBetween, parseIsoDate } from '../calendar/calendar-date';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { OccasionSchema, RowId } from '../schemas';
import type { TripFields } from './queries';

/**
 * The trip routes' input (#10). Trips are the owner's own, like outfits: no
 * route takes `?ownerId=`, and another user's trip is a 404 like an unknown
 * id. The trip form is two layers, as the capsule and plan forms: TypeBox
 * caps shape and length (a 400 page; the inputs carry the same maxlength),
 * then readTripForm re-renders the form with a message for what a person
 * can get wrong (a blank name, a missing or backward date, a trip longer
 * than MAX_TRIP_DAYS). The other writes post ids and values the pages
 * built, so anything malformed is a 400.
 */

export const TRIP_NOT_FOUND = 'Trip not found';

/** A trip that is not the signed-in owner's, whether it exists or not. */
export function tripNotFound(): HttpError {
  return new HttpError(404, TRIP_NOT_FOUND);
}

export const TRIP_NAME_MAX = 80;
/** The weather's place names are this long at most (PLACE_NAME_MAX). */
export const TRIP_DESTINATION_MAX = 200;
export const TRIP_NOTES_MAX = 2000;
export const TRIP_ITEM_MAX = 80;
/** The longest trip: a packing list for more is a move, not a trip. */
export const MAX_TRIP_DAYS = 60;
/** Ids one checklist post may carry: more than any trip holds. */
const MAX_IDS = 500;

export const TripParams = Type.Object({ id: RowId });

export const TripOutfitParams = Type.Object({
  id: RowId,
  tripOutfitId: RowId,
});

export const TripItemParams = Type.Object({ id: RowId, itemId: RowId });

// Dates arrive as the date inputs' strings: readTripForm judges them, so a
// blank one is a message on the form, not an error page.
export const TripBody = Type.Object({
  name: Type.String({ maxLength: TRIP_NAME_MAX }),
  destination: Type.Optional(Type.String({ maxLength: TRIP_DESTINATION_MAX })),
  startsOn: Type.String({ maxLength: 10 }),
  endsOn: Type.String({ maxLength: 10 }),
  notes: Type.Optional(Type.String({ maxLength: TRIP_NOTES_MAX })),
});
export type TripBody = Static<typeof TripBody>;

export type TripField = 'name' | 'startsOn' | 'endsOn';

export type TripForm =
  | { ok: true; fields: TripFields }
  | { ok: false; values: TripBody; errors: FieldErrors<TripField> };

/**
 * The form as stored: trimmed, blank destination and notes null; a blank
 * name, a missing date, an end before the start or a trip past
 * MAX_TRIP_DAYS are refused with their message.
 */
export function readTripForm(body: TripBody): TripForm {
  const name = body.name.trim();
  const { startsOn, endsOn, errors } = readDates(body);
  if (!name) errors.name = [t('trips.NAME_REQUIRED')];
  if (!startsOn || !endsOn || Object.keys(errors).length > 0) {
    return { ok: false, values: body, errors };
  }
  return {
    ok: true,
    fields: {
      name,
      destination: body.destination?.trim() || null,
      startsOn,
      endsOn,
      notes: body.notes?.trim() || null,
    },
  };
}

/** The first and last day, and what is wrong with them. */
function readDates(body: TripBody): {
  startsOn: string | undefined;
  endsOn: string | undefined;
  errors: FieldErrors<TripField>;
} {
  const startsOn = parseIsoDate(body.startsOn);
  const endsOn = parseIsoDate(body.endsOn);
  const errors: FieldErrors<TripField> = {};
  if (!startsOn) errors.startsOn = [t('trips.DATE_REQUIRED')];
  if (!endsOn) errors.endsOn = [t('trips.DATE_REQUIRED')];
  if (startsOn && endsOn) {
    const days = daysBetween(startsOn, endsOn) + 1;
    if (days < 1) errors.endsOn = [t('trips.ENDS_BEFORE_START')];
    else if (days > MAX_TRIP_DAYS) {
      errors.endsOn = [t('trips.TOO_LONG', { days: MAX_TRIP_DAYS })];
    }
  }
  return { startsOn, endsOn, errors };
}

/**
 * POST /trips/:id/outfits (the add page's saved outfits): the outfit and,
 * optionally, the trip day and occasion it is for ('' for none: the page's
 * "Any day"). A day outside the trip is refused by the writer (400).
 */
export const AddOutfitBody = Type.Object({
  outfitId: RowId,
  day: Type.Optional(
    Type.Union([Type.Literal(''), Type.String({ format: 'date' })]),
  ),
  occasion: Type.Optional(Type.Union([Type.Literal(''), OccasionSchema])),
});

/** `?day=&occasion=` on the add page: navigation state, lenient. */
export const AddOutfitQuery = Type.Object({
  day: Type.Optional(Type.String()),
  occasion: Type.Optional(Type.String()),
});

/**
 * A checklist's autosave (the packing list, the extras): the checked ids
 * and every id it showed. Shown and unchecked is unpacked; ids it never
 * showed (a garment added meanwhile) are left alone, the capsule toggles'
 * rule (`unchecked`, src/web/capsules/validation.ts). Nothing checked posts
 * no `packed`.
 */
export const ChecklistBody = Type.Union([
  Type.Object({
    packed: Type.Optional(Type.Array(RowId, { maxItems: MAX_IDS })),
    shown: Type.Optional(Type.Array(RowId, { maxItems: MAX_IDS })),
  }),
  Type.Null(),
]);

export const ItemBody = Type.Object({
  label: Type.String({ minLength: 1, maxLength: TRIP_ITEM_MAX }),
});

export const CopyItemsBody = Type.Object({ from: RowId });

/** A place picked from the geocoding search (the weather's own shape). */
export const DestinationBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: TRIP_DESTINATION_MAX }),
  latitude: Type.Number({ minimum: -90, maximum: 90 }),
  longitude: Type.Number({ minimum: -180, maximum: 180 }),
});

/** The trip page's one-shot flags: after a create, a gallery pick and a copy of extras. */
export const TripPageQuery = Type.Object({
  created: Type.Optional(Type.String({ maxLength: 5 })),
  picked: Type.Optional(Type.String({ maxLength: 5 })),
  copied: Type.Optional(Type.Integer({ minimum: 0 })),
});
