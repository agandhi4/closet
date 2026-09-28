import type { Occasion } from '../../wardrobe/occasions';
import { t, type StringKey } from '../i18n';
import {
  dateParts,
  dayOfWeek,
  type IsoDate,
  type YearMonth,
} from './calendar-date';

/**
 * The calendar's words for days, months and occasions, shared by the week,
 * the month, the plan page and its sheet, and Today (#15).
 */

/** Indexed by weekday, 0 = Sunday. */
export const DAY_NAMES: StringKey[] = [
  'CALENDAR_DAY_SUN',
  'CALENDAR_DAY_MON',
  'CALENDAR_DAY_TUE',
  'CALENDAR_DAY_WED',
  'CALENDAR_DAY_THU',
  'CALENDAR_DAY_FRI',
  'CALENDAR_DAY_SAT',
];

export const DAY_LETTERS: StringKey[] = [
  'CALENDAR_CAL_SUN_LETTER',
  'CALENDAR_CAL_MON_LETTER',
  'CALENDAR_CAL_TUE_LETTER',
  'CALENDAR_CAL_WED_LETTER',
  'CALENDAR_CAL_THU_LETTER',
  'CALENDAR_CAL_FRI_LETTER',
  'CALENDAR_CAL_SAT_LETTER',
];

/** Indexed by month - 1. */
export const MONTH_NAMES: StringKey[] = [
  'MONTH_JAN',
  'MONTH_FEB',
  'MONTH_MAR',
  'MONTH_APR',
  'MONTH_MAY',
  'MONTH_JUN',
  'MONTH_JUL',
  'MONTH_AUG',
  'MONTH_SEP',
  'MONTH_OCT',
  'MONTH_NOV',
  'MONTH_DEC',
];

/** Indexed by month - 1: the month page's title. */
export const MONTH_LONG_NAMES: StringKey[] = [
  'calendar.month.JAN',
  'calendar.month.FEB',
  'calendar.month.MAR',
  'calendar.month.APR',
  'calendar.month.MAY',
  'calendar.month.JUN',
  'calendar.month.JUL',
  'calendar.month.AUG',
  'calendar.month.SEP',
  'calendar.month.OCT',
  'calendar.month.NOV',
  'calendar.month.DEC',
];

/** "Tuesday, Sep 29". */
export function dayLabel(date: IsoDate): string {
  const { month, day } = dateParts(date);
  return t('CALENDAR_PLAN_DAY', {
    weekday: t(DAY_NAMES[dayOfWeek(date)]),
    month: t(MONTH_NAMES[month - 1]),
    day,
  });
}

/** "Sep 29". */
export function shortDayLabel(date: IsoDate): string {
  const { month, day } = dateParts(date);
  return t('calendar.SHORT_DAY', { month: t(MONTH_NAMES[month - 1]), day });
}

/**
 * The week's heading: "Sep 27 – Oct 3, 2026", or "Dec 29, 2030 – Jan 4,
 * 2031" across a new year. Always with the year: the app bar says only
 * "Calendar", so a `?week=` of another year would otherwise read like this
 * one's. The same for every week, so `/calendar` stays byte-stable.
 */
export function weekRangeLabel(first: IsoDate, last: IsoDate): string {
  const from = dateParts(first);
  const to = dateParts(last);
  if (from.year === to.year) {
    return t('calendar.WEEK_RANGE', {
      from: shortDayLabel(first),
      to: shortDayLabel(last),
      year: to.year,
    });
  }
  const withYear = ({ year, month, day }: typeof from) =>
    t('calendar.SHORT_DAY_YEAR', {
      month: t(MONTH_NAMES[month - 1]),
      day,
      year,
    });
  return t('calendar.WEEK_RANGE_YEARS', {
    from: withYear(from),
    to: withYear(to),
  });
}

/** "September 2026" (a month page's title). */
export function monthLabel({ year, month }: YearMonth): string {
  return t('calendar.MONTH_TITLE', {
    month: t(MONTH_LONG_NAMES[month - 1]),
    year,
  });
}

/** "Night out". Every occasion has its catalog string: a missing one is a type error. */
export function occasionLabel(occasion: Occasion): string {
  return t(`occasion.${occasion}`);
}
