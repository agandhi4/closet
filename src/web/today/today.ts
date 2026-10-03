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
import { type WaitingDraft, waitingDraftsSql } from '../plans/queries';
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
 * So are an agent's drafts waiting on the owner (`drafts`, #295), which only
 * the page shows, as a card.
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
  /** An agent's drafts with proposals to review (waitingDraftsSql); read only when asked (`drafts`). */
  drafts?: WaitingDraft[];
}

export interface TodayOptions {
  /**
   * The person's weather when the caller read it already (the morning
   * reminders' batch refresh, refreshForecastsFor, #173); else read here.
   */
  ownWeather?: UserWeather;
  /** Also read whether anything was worn today (get_today; the page never shows it). */
  worn?: boolean;
  /** Also read the agent's drafts waiting on the owner (the page's card). */
  drafts?: boolean;
}

export interface TodayDeps {
  db: Db;
  weather: WeatherService | undefined;
  timeZone: string;
}

/**
 * The day's entries, the person's settings with their forecast row, and
 * (when asked) whether anything was worn and the agent's drafts waiting
 * on review, in one statement (#172; the
 * entries and the weather were two, in parallel), so the ideas start with
 * the weather in hand. Only a forecast that must be fetched reads again
 * (userWeatherFrom).
 */
async function readDay(
  deps: TodayDeps,
  ownerId: number,
  today: IsoDate,
  now: Date,
  { ownWeather, worn, drafts }: TodayOptions,
) {
  const read = await selectScalars(deps.db, {
    entries: entriesSql(ownerId, today, today),
    weather:
      ownWeather || !deps.weather
        ? undefined
        : weatherWithForecastSql(ownerId, now),
    worn: worn ? somethingWornSql(ownerId, today) : undefined,
    drafts: drafts ? waitingDraftsSql(ownerId) : undefined,
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
    drafts: read.drafts,
  };
}

export async function todayFor(
  deps: TodayDeps,
  ownerId: number,
  now: Date,
  options: TodayOptions = {},
): Promise<TodayModel> {
  const today = todayIn(deps.timeZone, now);
  const { entries, weather, worn, drafts } = await readDay(
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
  return { today, rows, weather: weather ?? null, wornToday: worn, drafts };
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
