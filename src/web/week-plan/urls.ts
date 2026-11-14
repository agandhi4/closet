/**
 * The weekly auto-plan's addresses (#16). "Plan my week" and its Undo are
 * calendar writes (the dock marks Calendar); the template is a section of
 * the Profile, saved under it.
 */

import { CALENDAR_PATH, dayAnchor } from '../calendar/urls';
import { type IsoDate, startOfWeek } from '../../calendar-date';

export const PLAN_WEEK_PATH = '/calendar/plan-week';

/** Undo of one "Plan my week". */
export function undoWeekPlanUrl(weekPlanId: number): string {
  return `${PLAN_WEEK_PATH}/${weekPlanId}/undo`;
}

/**
 * What a plan answers: the week holding the batch's first planned day,
 * scrolled to that day, with the banner (`?planned=`); the current week
 * with the banner alone when nothing was left to plan ('none').
 */
export function plannedWeekUrl(
  planned: number | 'none',
  firstDay?: IsoDate,
): string {
  const flag = `${PLANNED_FLAG}=${planned}`;
  if (!firstDay) return `${CALENDAR_PATH}?${flag}`;
  return `${CALENDAR_PATH}?week=${startOfWeek(firstDay)}&${flag}#${dayAnchor(firstDay)}`;
}

/** The calendar's one-shot flags: the banner after a plan, the toast after an undo. */
export const PLANNED_FLAG = 'planned';
export const UNDONE_FLAG = 'undone';

/** The Profile's week template section, and where its form posts. */
export const WEEK_SETTINGS_ID = 'week';
export const WEEK_SETTINGS_PATH = `/auth/profile#${WEEK_SETTINGS_ID}`;
export const WEEK_TEMPLATE_PATH = '/auth/profile/week';
/** The Profile's one-shot flag after the template is saved. */
export const WEEK_SAVED_FLAG = 'weekSaved';
