import type { Db } from '../../db/client';
import type { Idea } from '../../wardrobe/generator';
import {
  DAY_OCCASIONS,
  DEFAULT_OCCASION,
  type Occasion,
} from '../../wardrobe/occasions';
import { type IsoDate, todayIn } from '../calendar/calendar-date';
import { dailySeed, ideasFor, type IdeasWeather } from '../gallery/ideas';
import type { PoolGarment } from '../gallery/queries';
import type { WeatherService } from '../weather/service';
import { somethingWornOn, type TodayEntry, todayEntries } from './queries';

/**
 * Today (#15; plan section 9): the household's day for one person, as a
 * row per occasion. The page (routes.tsx), the MCP tool get_today and the
 * push reminders (src/web/push/reminders.ts) all read it here, so the
 * three never disagree about what is planned or suggested.
 *
 * - A row per occasion planned today, holding its entries (occasion order).
 * - While nothing that dresses the day is planned (DAY_OCCASIONS: all day,
 *   work, daytime), an all-day row of suggestions first: a page of
 *   TODAY_IDEAS from ideasFor for today's forecast, the day's seed
 *   (dailySeed, as the gallery opens with), so a reload shows the same
 *   three and Refresh walks the pages.
 */

/** Ideas a suggestions row shows at once. */
export const TODAY_IDEAS = 3;

/** Refresh stops at this page and starts over. */
export const MAX_TODAY_PAGE = 20;

export interface PlannedRow {
  kind: 'planned';
  occasion: Occasion;
  entries: TodayEntry[];
}

export interface IdeasRow {
  kind: 'ideas';
  occasion: Occasion;
  ideas: Idea<PoolGarment>[];
  /** 1-based page of the day's ideas. */
  page: number;
  /** The page Refresh shows: the next, or the first again after the last. */
  nextPage: number;
  weather: IdeasWeather | null;
}

export type TodayRow = PlannedRow | IdeasRow;

export interface TodayModel {
  today: IsoDate;
  rows: TodayRow[];
  /** Anything marked worn today (an entry, a garment's "Wore today"). */
  wornToday: boolean;
}

export interface TodayDeps {
  db: Db;
  weather: WeatherService | undefined;
  timeZone: string;
}

export async function todayFor(
  deps: TodayDeps,
  ownerId: number,
  now: Date,
): Promise<TodayModel> {
  const today = todayIn(deps.timeZone, now);
  const [entries, wornToday] = await Promise.all([
    todayEntries(deps.db, ownerId, today),
    somethingWornOn(deps.db, ownerId, today),
  ]);
  const rows: TodayRow[] = [];
  for (const entry of entries) {
    const last = rows.at(-1);
    if (last?.kind === 'planned' && last.occasion === entry.occasion) {
      last.entries.push(entry);
    } else {
      rows.push({
        kind: 'planned',
        occasion: entry.occasion,
        entries: [entry],
      });
    }
  }
  const dressed = entries.some((e) => DAY_OCCASIONS.includes(e.occasion));
  if (!dressed) {
    // All day sorts first among occasions, so it opens the list.
    rows.unshift(await todayIdeas(deps, ownerId, now, DEFAULT_OCCASION, 1));
  }
  return { today, rows, wornToday };
}

/**
 * A page of today's ideas for `occasion` (Refresh's fragment asks for the
 * next). A page past the end (the closet changed since the page was drawn)
 * starts over at the first.
 */
export async function todayIdeas(
  deps: TodayDeps,
  ownerId: number,
  now: Date,
  occasion: Occasion,
  page: number,
): Promise<IdeasRow> {
  const today = todayIn(deps.timeZone, now);
  const ask = (asked: number) =>
    ideasFor(
      { db: deps.db, weather: deps.weather },
      ownerId,
      {
        today,
        day: today,
        occasion,
        seed: dailySeed(today),
        offset: (asked - 1) * TODAY_IDEAS,
        limit: TODAY_IDEAS,
      },
      now,
    );
  let shown = page;
  let result = await ask(shown);
  if (result.ideas.length === 0 && shown > 1) {
    shown = 1;
    result = await ask(shown);
  }
  return {
    kind: 'ideas',
    occasion,
    ideas: result.ideas,
    page: shown,
    nextPage: result.more && shown < MAX_TODAY_PAGE ? shown + 1 : 1,
    weather: result.weather,
  };
}
