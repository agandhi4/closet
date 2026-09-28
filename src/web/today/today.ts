import type { Db } from '../../db/client';
import type { Idea } from '../../wardrobe/generator';
import {
  compareOccasions,
  DAY_OCCASIONS,
  DEFAULT_OCCASION,
  type Occasion,
} from '../../wardrobe/occasions';
import { type IsoDate, todayIn } from '../calendar/calendar-date';
import type { CalendarEntry } from '../calendar/calendar-view';
import { findEntries } from '../calendar/queries';
import { dailySeed, ideasFor, type IdeasWeather } from '../gallery/ideas';
import type { PoolGarment } from '../gallery/queries';
import {
  userWeather,
  type UserWeather,
  type WeatherService,
} from '../weather/service';

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
 * - The person's weather (settings and forecast), read once beside the
 *   entries: the page's line and the ideas' matching share it.
 *
 * Whether anything was worn today is not in it: the page never shows it,
 * so its readers that need it (get_today, the evening reminder) ask
 * somethingWornOn themselves (#158).
 */

/** Ideas a suggestions row shows at once. */
export const TODAY_IDEAS = 3;

/** Refresh stops at this page and starts over. */
export const MAX_TODAY_PAGE = 20;

export interface PlannedRow {
  kind: 'planned';
  occasion: Occasion;
  entries: CalendarEntry[];
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
  /** Null with WEATHER_ENABLED=false. */
  weather: UserWeather | null;
}

export interface TodayDeps {
  db: Db;
  weather: WeatherService | undefined;
  timeZone: string;
}

/**
 * `ownWeather`: the person's weather when the caller read it already (the
 * morning reminders' batch refresh, refreshForecastsFor, #173); else read
 * here.
 */
export async function todayFor(
  deps: TodayDeps,
  ownerId: number,
  now: Date,
  ownWeather?: UserWeather,
): Promise<TodayModel> {
  const today = todayIn(deps.timeZone, now);
  // Together: the page waits for one round trip here, not two in turn, and
  // the ideas below start with the weather in hand.
  const [entries, weather] = await Promise.all([
    findEntries(deps.db, ownerId, today, today),
    ownWeather ??
      (deps.weather && userWeather(deps.db, deps.weather, ownerId, now)),
  ]);
  // Occasion order, the calendar's; a stable sort keeps the planned first.
  entries.sort((a, b) => compareOccasions(a.occasion, b.occasion));
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
    rows.unshift(
      await todayIdeas(deps, ownerId, now, DEFAULT_OCCASION, 1, weather),
    );
  }
  return { today, rows, weather: weather ?? null };
}

/**
 * A page of today's ideas for `occasion` (Refresh's fragment asks for the
 * next). A page past the end (the closet changed since the page was drawn)
 * starts over at the first. `ownWeather`: the person's weather when the
 * caller read it already (todayFor); else ideasFor reads it.
 */
export async function todayIdeas(
  deps: TodayDeps,
  ownerId: number,
  now: Date,
  occasion: Occasion,
  page: number,
  ownWeather?: UserWeather,
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
        ownWeather,
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
