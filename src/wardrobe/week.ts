import {
  compareOccasions,
  DAY_OCCASIONS,
  type Occasion,
  OCCASIONS,
} from './occasions';

/**
 * The week template (#16; plan section 12): which occasions each weekday
 * holds ("Monday to Friday work, a run on Monday and Thursday, Saturday
 * daytime"). The one model of how a person's week is shaped: "Plan my
 * week" fills its slots, and the style profile's rhythm ("work 3 a week",
 * #34a) is derived from it (weeklyRhythm), never stored beside it. Pure: no
 * database, web or strings (weekday names are the calendar's labels).
 *
 * A weekday holds at most one of DAY_OCCASIONS (all day, work, daytime: the
 * outfit worn through the day) and any of the others around it (a morning
 * workout, an evening, a night out). The week_template table enforces the
 * first with a partial unique index; the editor offers one choice for it.
 */

/**
 * Who owns a calendar entry's choice (outfit_calendar.planned_by): the
 * person, or the week planner while its pick stands untouched (the only
 * entries its daily re-plan may swap).
 */
export const PLANNED_BY = ['user', 'auto'] as const;
export type PlannedBy = (typeof PLANNED_BY)[number];
export const DEFAULT_PLANNED_BY: PlannedBy = 'user';

/** 0 = Sunday ... 6 = Saturday: calendar-date.ts's dayOfWeek, weeks run Sunday to Saturday. */
export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** The occasions that come around the day's outfit: any number of them per weekday. */
export const AROUND_OCCASIONS: readonly Occasion[] = OCCASIONS.filter(
  (occasion) => !DAY_OCCASIONS.includes(occasion),
);

export interface TemplateSlot {
  weekday: Weekday;
  occasion: Occasion;
}

/** One weekday of a template: its day occasion (or none) and what comes around it. */
export interface TemplateDay {
  weekday: Weekday;
  day: Occasion | null;
  /** AROUND_OCCASIONS in occasion order. */
  around: Occasion[];
}

/** A template as seven days, Sunday first (the editor's rows, the MCP answer). */
export function templateDays(slots: readonly TemplateSlot[]): TemplateDay[] {
  return WEEKDAYS.map((weekday) => {
    const occasions = slots
      .filter((slot) => slot.weekday === weekday)
      .map((slot) => slot.occasion)
      .sort(compareOccasions);
    return {
      weekday,
      day: occasions.find((o) => DAY_OCCASIONS.includes(o)) ?? null,
      around: occasions.filter((o) => AROUND_OCCASIONS.includes(o)),
    };
  });
}

/** Seven days back to slots, weekday then occasion order. */
export function templateSlots(days: readonly TemplateDay[]): TemplateSlot[] {
  return days.flatMap(({ weekday, day, around }) =>
    [...(day ? [day] : []), ...new Set(around)]
      .sort(compareOccasions)
      .map((occasion) => ({ weekday, occasion })),
  );
}

/** The occasions a weekday holds, in occasion order. */
export function occasionsOn(
  slots: readonly TemplateSlot[],
  weekday: number,
): Occasion[] {
  return slots
    .filter((slot) => slot.weekday === weekday)
    .map((slot) => slot.occasion)
    .sort(compareOccasions);
}

/** How often an occasion comes round a week. */
export interface RhythmEntry {
  occasion: Occasion;
  perWeek: number;
}

/**
 * The week's rhythm, derived: each occasion the template holds and on how
 * many weekdays, in occasion order ("Work 3 a week"). What the style
 * profile shows and get_style_profile answers; stored nowhere.
 */
export function weeklyRhythm(slots: readonly TemplateSlot[]): RhythmEntry[] {
  return OCCASIONS.flatMap((occasion) => {
    const perWeek = new Set(
      slots.filter((s) => s.occasion === occasion).map((s) => s.weekday),
    ).size;
    return perWeek > 0 ? [{ occasion, perWeek }] : [];
  });
}
