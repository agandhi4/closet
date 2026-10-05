import type { Db } from '../../db/client';
import { selectScalars } from '../../db/select-scalars';
import type { Idea } from '../../wardrobe/generator';
import {
  compareOccasions,
  DAY_OCCASIONS,
  DEFAULT_OCCASION,
  type Occasion,
} from '../../wardrobe/occasions';
import { type IsoDate, todayIn } from '../calendar/calendar-date';
import type { CalendarEntry } from '../calendar/calendar-view';
import { entriesSql } from '../calendar/queries';
import { dailySeed, ideasFor, type IdeasWeather } from '../gallery/ideas';
import type { PoolGarment } from '../gallery/queries';
import {
  type NextPurchase,
  nextPurchaseOf,
  rankedPurchasesSql,
} from '../plans/candidates';
import {
  readWeatherWithForecast,
  weatherWithForecastSql,
} from '../weather/queries';
import {
  type UserWeather,
  userWeatherFrom,
  type WeatherService,
} from '../weather/service';
import { somethingWornSql } from './queries';
import { type NeedsToDecide, needsToDecideSql } from '../wishlist/inbox';
import { type MuseRound, museRoundSql } from '../wishlist/rounds';

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
 * Whether anything was worn today is read only when asked (`worn`, in the
 * same statement): the page never shows it (#158); get_today asks, and the
 * evening reminder reads it for every evening person at once (eveningDays).
 * So are Muse's needs waiting on the owner's choice (`needs`, #333) and
 * its latest round while any of it waits (#337), which only the page
 * shows, as one card: the round's while it waits, else the needs'.
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
  /** Whether anything was worn today (somethingWornSql); read only when asked (`worn`). */
  wornToday?: boolean;
  /** Muse's needs with options to choose (needsToDecideSql); null for none; read only when asked (`needs`). */
  needs?: NeedsToDecide | null;
  /** Muse's latest round while any of it waits (museRoundSql); null otherwise; read with `needs`. */
  round?: MuseRound | null;
  /** The product completing the most loved looks of the active plan (rankedPurchasesSql, finished by nextPurchaseOf); null when none; read only when asked (`nextPurchase`). */
  nextPurchase?: NextPurchase | null;
}

export interface TodayOptions {
  /**
   * The person's weather when the caller read it already (the morning
   * reminders' batch refresh, refreshForecastsFor, #173); else read here.
   */
  ownWeather?: UserWeather;
  /** Also read whether anything was worn today (get_today; the page never shows it). */
  worn?: boolean;
  /** Also read Muse's needs and latest round waiting on the owner (the page's card). */
  needs?: boolean;
  /** Also read the next product to buy (the page's card when no need waits). */
  nextPurchase?: boolean;
}

export interface TodayDeps {
  db: Db;
  weather: WeatherService | undefined;
  timeZone: string;
}

/**
 * The day's entries, the person's settings with their forecast row, and
 * (when asked) whether anything was worn and Muse's needs waiting on a
 * choice, in one statement (#172; the
 * entries and the weather were two, in parallel), so the ideas start with
 * the weather in hand. Only a forecast that must be fetched reads again
 * (userWeatherFrom).
 */
async function readDay(
  deps: TodayDeps,
  ownerId: number,
  today: IsoDate,
  now: Date,
  { ownWeather, worn, needs, nextPurchase }: TodayOptions,
) {
  const read = await selectScalars(deps.db, {
    entries: entriesSql(ownerId, today, today),
    weather:
      ownWeather || !deps.weather
        ? undefined
        : weatherWithForecastSql(ownerId, now),
    worn: worn ? somethingWornSql(ownerId, today) : undefined,
    needs: needs ? needsToDecideSql(ownerId) : undefined,
    round: needs ? museRoundSql(ownerId) : undefined,
    ranked: nextPurchase ? rankedPurchasesSql(ownerId) : undefined,
  });
  const weather =
    ownWeather ??
    (deps.weather &&
      (await userWeatherFrom(
        deps.weather,
        readWeatherWithForecast(read.weather ?? null, now),
        now,
      )));
  return {
    entries: read.entries,
    weather,
    worn: read.worn,
    needs: read.needs,
    round: read.round,
    // A waiting round's or need's card wins the slot: skip the matching statements.
    nextPurchase:
      read.ranked && !read.needs && !read.round
        ? await nextPurchaseOf(deps.db, ownerId, read.ranked)
        : undefined,
  };
}

export async function todayFor(
  deps: TodayDeps,
  ownerId: number,
  now: Date,
  options: TodayOptions = {},
): Promise<TodayModel> {
  const today = todayIn(deps.timeZone, now);
  const { entries, weather, worn, needs, round, nextPurchase } = await readDay(
    deps,
    ownerId,
    today,
    now,
    options,
  );
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
  return {
    today,
    rows,
    weather: weather ?? null,
    wornToday: worn,
    needs,
    round,
    nextPurchase,
  };
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
