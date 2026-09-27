import type { Occasion } from '../../wardrobe/occasions';
import { t, type StringKey } from '../i18n';
import { dateParts, dayOfWeek, type IsoDate } from './calendar-date';

/**
 * The calendar's words for days, months and occasions, shared by the week
 * page and the plan page (and Today, #15, when it lands).
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

/** "Tuesday, Sep 29". */
export function dayLabel(date: IsoDate): string {
  const { month, day } = dateParts(date);
  return t('CALENDAR_PLAN_DAY', {
    weekday: t(DAY_NAMES[dayOfWeek(date)]),
    month: t(MONTH_NAMES[month - 1]),
    day,
  });
}

/** "Night out". Every occasion has its catalog string: a missing one is a type error. */
export function occasionLabel(occasion: Occasion): string {
  return t(`occasion.${occasion}`);
}
