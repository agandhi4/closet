import { addDays, instantAt, type IsoDate } from '../../src/calendar-date';
import type { LastWash, WearInstant } from '../../src/wardrobe/availability';

/**
 * The wash rule's case table (#676): wearsSinceWash
 * (src/wardrobe/availability.spec.ts) and its SQL twin wearsSinceWashSql
 * (test/integration/wears.spec.ts) each answer every row, and both must
 * give `count`. Days are offsets from the wash day (0), hours that day's
 * wall clock in the time zone the caller dates them in; a null hour is an
 * instant not known (a backfilled wear, a timeless wash).
 */
export interface WashCase {
  name: string;
  wears: { day: number; hour: number | null }[];
  /** Null: never washed. `instantDay` puts washed_at on another day than its own. */
  wash: { hour: number | null; instantDay?: number } | null;
  count: number;
}

export const WASH_CASES: readonly WashCase[] = [
  {
    name: 'never washed',
    wears: [{ day: -2, hour: null }],
    wash: null,
    count: 1,
  },
  {
    name: 'worn the day before',
    wears: [{ day: -1, hour: 19 }],
    wash: { hour: 9 },
    count: 0,
  },
  {
    name: 'worn the day after',
    wears: [{ day: 1, hour: null }],
    wash: { hour: 9 },
    count: 1,
  },
  {
    name: 'washed 09:00, worn 19:00',
    wears: [{ day: 0, hour: 19 }],
    wash: { hour: 9 },
    count: 1,
  },
  {
    name: 'worn 08:00, washed 21:00',
    wears: [{ day: 0, hour: 8 }],
    wash: { hour: 21 },
    count: 0,
  },
  {
    name: 'backfilled wear on the wash day',
    wears: [{ day: 0, hour: null }],
    wash: { hour: 9 },
    count: 0,
  },
  {
    name: 'timeless wash, wear at 19:00',
    wears: [{ day: 0, hour: 19 }],
    wash: { hour: null },
    count: 0,
  },
  {
    name: 'timeless wash, backfilled wear',
    wears: [{ day: 0, hour: null }],
    wash: { hour: null },
    count: 0,
  },
  {
    name: 'worn at the wash instant',
    wears: [{ day: 0, hour: 9 }],
    wash: { hour: 9 },
    count: 0,
  },
  {
    name: 'worn before and after the wash, one day',
    wears: [
      { day: 0, hour: 8 },
      { day: 0, hour: 19 },
    ],
    wash: { hour: 9 },
    count: 1,
  },
  {
    name: 'worn that evening and the next day',
    wears: [
      { day: 0, hour: 19 },
      { day: 1, hour: 12 },
    ],
    wash: { hour: 9 },
    count: 2,
  },
  {
    // markWashed never writes one (instantOnDay); the twins compare
    // instants alone, so a washed_at the day before reads as earlier than
    // every wear of the wash day.
    name: 'washed_at on the day before its last_washed_on',
    wears: [{ day: 0, hour: 8 }],
    wash: { hour: 20, instantDay: -1 },
    count: 1,
  },
];

/** A case's wears and wash, dated from `washDay` in `timeZone`. */
export function washCaseRows(
  c: WashCase,
  washDay: IsoDate,
  timeZone: string,
): { wears: WearInstant[]; lastWash: LastWash | null } {
  const at = (day: number, hour: number | null) =>
    hour === null
      ? null
      : instantAt(addDays(washDay, day), hour, timeZone).getTime();
  return {
    wears: c.wears.map((w) => ({
      day: addDays(washDay, w.day),
      wornAt: at(w.day, w.hour),
    })),
    lastWash: c.wash && {
      day: washDay,
      washedAt: at(c.wash.instantDay ?? 0, c.wash.hour),
    },
  };
}
