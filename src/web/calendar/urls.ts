import { type DayDestination, destinationQuery } from '../outfits/destination';
import type { IsoDate } from '../../calendar-date';

/**
 * The calendar's addresses, built from parsed values (a real date, a
 * 'YYYY-MM', a known occasion), so nothing needs encoding. `/calendar` is
 * the dock's tab (layout/sections.ts) and a stale-while-revalidate tab root
 * (page-cache.ts).
 */

export const CALENDAR_PATH = '/calendar';
/** The month of collages (R6): `?month=YYYY-MM`, this month without. */
export const CALENDAR_MONTH_PATH = `${CALENDAR_PATH}/month`;
/** The plan page: Change (#69), Today's "+ Plan another outfit" and links cached before R6. */
export const CALENDAR_PLAN_PATH = `${CALENDAR_PATH}/plan`;

/** The week holding `day`; the current week without one. */
export function weekUrl(day?: IsoDate): string {
  return day ? `${CALENDAR_PATH}?week=${day}` : CALENDAR_PATH;
}

/** The week holding `day`, scrolled to it (the agenda's `#day-D` sections). */
export function dayUrl(day: IsoDate): string {
  return `${weekUrl(day)}#${dayAnchor(day)}`;
}

export function dayAnchor(day: IsoDate): string {
  return `day-${day}`;
}

/** A month's page for its 'YYYY-MM'. */
export function monthUrl(month: string): string {
  return `${CALENDAR_MONTH_PATH}?month=${month}`;
}

/** The plan page for a day (and the entry it would change, #69). */
export function planPageUrl(destination: DayDestination): string {
  return `${CALENDAR_PLAN_PATH}?${destinationQuery(destination)}`;
}
