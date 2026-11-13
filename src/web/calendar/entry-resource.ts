import { CloneType, type Static, Type } from '@sinclair/typebox';
import { OCCASIONS } from '../../wardrobe/occasions';
import { PLANNED_BY } from '../../wardrobe/week';
import { literals, withoutNulls } from '../api/resource';
import {
  OutfitGarmentResource,
  toOutfitGarment,
} from '../outfits/outfit-resource';
import { IsoDateSchema, RowId } from '../schemas';
import type { CalendarEntry } from './calendar-view';
import { MAX_CALENDAR_DAYS, type ScheduleOutcome } from './queries';
import type { Replaced } from './replace';

/**
 * The API's calendar entry resources and inputs (#193b; docs/plans/
 * 2026-11-12-json-api.md section 2), mapped from what the week page and
 * get_calendar read (entriesSql). A household day is `YYYY-MM-DD`; null
 * fields are left out. Entries are the token's user's own: a share never
 * reaches one.
 */

const Occasion = literals(OCCASIONS);

export const CalendarEntryResource = Type.Object(
  {
    id: Type.Integer(),
    day: IsoDateSchema,
    occasion: Occasion,
    worn: Type.Boolean(),
    plannedBy: CloneType(literals(PLANNED_BY), {
      description:
        "`auto`: Plan my week's pick, which its daily re-plan may swap until you change, wear or plan it yourself; `user`: yours",
    }),
    selfieId: Type.Optional(
      Type.Integer({ description: 'The outfit selfie taken of it' }),
    ),
    outfit: Type.Object(
      {
        id: Type.Integer(),
        name: Type.Optional(Type.String()),
        garments: Type.Array(OutfitGarmentResource),
      },
      { title: 'CalendarEntryOutfit' },
    ),
  },
  {
    title: 'CalendarEntry',
    description:
      'An outfit planned on a day for an occasion (a part of the day). A day holds several, one per outfit',
  },
);
type CalendarEntryResource = Static<typeof CalendarEntryResource>;

export function toCalendarEntryResource(
  entry: CalendarEntry,
): CalendarEntryResource {
  return {
    id: entry.id,
    day: entry.day,
    occasion: entry.occasion,
    worn: entry.worn,
    plannedBy: entry.plannedBy,
    ...(entry.selfie && { selfieId: entry.selfie.id }),
    outfit: {
      id: entry.outfit.id,
      ...withoutNulls({ name: entry.outfit.name }),
      garments: entry.outfit.garments.map(toOutfitGarment),
    },
  };
}

/** GET /calendar-entries: a range of days, never paged (it is at most MAX_CALENDAR_DAYS). */
export const CalendarEntryQuery = Type.Object({
  from: Type.Optional(
    CloneType(IsoDateSchema, {
      description: 'The first day; today unless given',
    }),
  ),
  to: Type.Optional(
    CloneType(IsoDateSchema, {
      description: `The last day (inclusive), at most ${MAX_CALENDAR_DAYS} days in all; six days after \`from\` unless given`,
    }),
  ),
});

export const CalendarEntryList = Type.Object(
  {
    from: IsoDateSchema,
    to: IsoDateSchema,
    data: Type.Array(CalendarEntryResource),
  },
  {
    title: 'CalendarEntryList',
    description:
      'Your entries from one day to another, by day, then occasion as the calendar stacks them. A range, not pages: ask for the next days',
  },
);

/** POST /calendar-entries. */
export const NewCalendarEntry = Type.Object(
  {
    outfitId: CloneType(RowId, {
      description:
        'One of your outfits; one with pieces still to buy (its `toBuy`) is a 409',
    }),
    day: IsoDateSchema,
    occasion: Type.Optional(
      CloneType(Occasion, { description: 'All day unless given' }),
    ),
    clientId: Type.Optional(
      Type.String({
        format: 'uuid',
        description:
          'Your id for this entry, for retrying it offline: accepted, not yet stored (an outfit is on a day once anyway)',
      }),
    ),
  },
  {
    title: 'NewCalendarEntry',
    description:
      'Plans an outfit on a day. Once a day per outfit: planning it again is that entry, its occasion kept',
  },
);

const SCHEDULE_OUTCOMES = [
  'scheduled',
  'already-scheduled',
] as const satisfies readonly ScheduleOutcome[];

export const CalendarEntryScheduled = Type.Object(
  {
    id: Type.Integer({ description: 'The entry' }),
    outcome: literals(SCHEDULE_OUTCOMES),
    occasion: CloneType(Occasion, {
      description: 'The one asked, or the one it kept when already planned',
    }),
    adopted: Type.Optional(
      Type.Boolean({
        description:
          "Already planned by Plan my week: it is yours now, out of the re-plan's reach",
      }),
    ),
  },
  { title: 'CalendarEntryScheduled' },
);

/** PUT /calendar-entries/{id}/outfit. */
export const EntryOutfitInput = Type.Object(
  {
    outfitId: CloneType(RowId, {
      description:
        'One of your outfits, not on that day already (a 409) and with no piece to buy',
    }),
  },
  { title: 'CalendarEntryOutfitInput' },
);

const REPLACE_OUTCOMES = [
  'replaced',
  'unchanged',
] as const satisfies readonly Replaced['outcome'][];

export const EntryOutfitChanged = Type.Object(
  {
    outcome: CloneType(literals(REPLACE_OUTCOMES), {
      description: '`unchanged`: it held that outfit already (a retry)',
    }),
    day: IsoDateSchema,
    occasion: Occasion,
    outfitId: Type.Integer(),
    previousOutfitId: Type.Integer(),
    selfieKeptAsLook: Type.Boolean({
      description:
        'Its selfie stays on the day as a look: it shows the old outfit',
    }),
    plannerOutfitRemoved: Type.Boolean({
      description:
        'The outfit Plan my week had made for it, held by nothing else, is gone',
    }),
  },
  { title: 'CalendarEntryOutfitChanged' },
);

export function toEntryOutfitChanged(
  replaced: Replaced,
): Static<typeof EntryOutfitChanged> {
  return {
    outcome: replaced.outcome,
    day: replaced.day,
    occasion: replaced.occasion,
    outfitId: replaced.outfitId,
    previousOutfitId: replaced.previousOutfitId,
    selfieKeptAsLook: replaced.selfieDetached !== undefined,
    plannerOutfitRemoved: replaced.outfitsRemoved > 0,
  };
}

/** PUT /calendar-entries/{id}/worn. */
export const EntryWornInput = Type.Object(
  { worn: Type.Boolean() },
  {
    title: 'CalendarEntryWornInput',
    description:
      'Worn (each of its garments worn that day) or not (those wears gone)',
  },
);

export const EntryWorn = Type.Object(
  {
    day: IsoDateSchema,
    worn: Type.Boolean(),
    /** False when it already was so: a retry. */
    changed: Type.Boolean(),
    wears: Type.Integer({
      minimum: 0,
      description: 'Garment wears logged or removed by this change',
    }),
  },
  { title: 'CalendarEntryWorn' },
);
