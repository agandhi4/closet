import type { Db } from '../../db/client';
import { selectScalars } from '../../db/select-scalars';
import type { TemplateSlot } from '../../wardrobe/week';
import { type DetachedLook, detachedLooksSql } from '../selfies/queries';
import { planDays, type PlannedBanner, plannedBanner } from '../week-plan/plan';
import { batchEntriesSql, entrySlotsSql } from '../week-plan/queries';
import { inTemplateOrder, weekTemplateSql } from '../week-plan/template';
import type { IsoDate } from '../../calendar-date';
import type { CalendarEntry } from './calendar-view';
import { entriesSql } from './queries';

/**
 * What GET /calendar shows for a week (calendar-page.tsx), each part for
 * one piece of the page:
 * - `entries`: the week's rows (OccasionRow), with their selfies;
 * - `looks`: the selfies kept on a day after their entry went (DayLooks);
 * - `template`: the open slots from today on (OpenSlotRow);
 * - `banner`: after "Plan my week" (`?planned=`), what it planned and the
 *   next 7 days' slots still empty (PlannedWeekBanner).
 */
export interface WeekContext {
  entries: CalendarEntry[];
  looks: DetachedLook[];
  template: TemplateSlot[];
  banner: PlannedBanner | undefined;
}

/**
 * The week `start` to `end` of the owner's calendar, in one statement
 * (selectScalars): the parts share no rows, and were three statements in
 * parallel, five with the banner, each on a connection of its own (#165;
 * production pays a ~114 ms round trip per statement, and a pool below its
 * fan-out opens connections at several round trips each). The banner's
 * parts are read only when `banner` asks for it.
 */
export async function weekContext(
  db: Db,
  ownerId: number,
  /** `today` draws today's cards (entriesSql's `washOn`). */
  week: { start: IsoDate; end: IsoDate; today: IsoDate },
  banner?: { planned: number | 'none'; today: IsoDate; hour: number },
): Promise<WeekContext> {
  const window = banner && planDays(banner.today);
  const row = await selectScalars(db, {
    entries: entriesSql(ownerId, week.start, week.end, {
      washOn: week.today,
    }),
    looks: detachedLooksSql(ownerId, week.start, week.end),
    template: weekTemplateSql(ownerId),
    batch:
      banner && banner.planned !== 'none'
        ? batchEntriesSql(ownerId, banner.planned)
        : undefined,
    window: window && entrySlotsSql(ownerId, window[0], window.at(-1)!),
  });
  const template = inTemplateOrder(row.template);
  return {
    entries: row.entries,
    looks: row.looks,
    template,
    banner:
      banner &&
      plannedBanner(
        banner.planned,
        { batch: row.batch ?? [], template, window: row.window ?? [] },
        banner,
      ),
  };
}
