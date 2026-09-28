import type { Db, Queryable } from '../../db/client';
import type { IdeaProblem } from '../../wardrobe/generator';
import type { Occasion } from '../../wardrobe/occasions';
import {
  emptySlots,
  PLAN_DAYS,
  type PlannedNeeds,
  plannedNeeds,
  planWeek,
  type Slot,
  type WeekContext,
} from '../../wardrobe/week-planner';
import type { DayForecast } from '../../weather/forecast';
import { ownerTransaction } from '../auth/queries';
import { addDays, type IsoDate } from '../calendar/calendar-date';
import { entryOf } from '../calendar/queries';
import { pickIdea } from '../gallery/ideas';
import {
  avoidedPairs,
  savedOutfits,
  weekPool,
  type WeekPoolGarment,
} from '../gallery/queries';
import type { ReadOptions } from '../weather/location-cache';
import { userWeather, type WeatherService } from '../weather/service';
import {
  batchAutoEntries,
  batchEntries,
  type BatchEntry,
  createWeekPlan,
  deleteEmptyWeekPlan,
  recordAutoEntry,
  removeAutoEntries,
  weekPlanOf,
  windowEntries,
} from './queries';
import { findWeekTemplate } from './template';

/**
 * "Plan my week" (#16; plan section 12): the week planner
 * (src/wardrobe/week-planner.ts, pure) fed from the database and the
 * forecast, and its writes. Called by POST /calendar/plan-week (routes.tsx),
 * the MCP tool plan_week and the seed; the daily re-plan (replan.ts) shares
 * writeAutoPick and the window's reads.
 *
 * A plan is one transaction under lockOwner: the template, the week's
 * entries and the pool are read after the lock, so a second tap (or a
 * retried plan_week) waits for the first, finds its slots filled and plans
 * nothing. Every outfit is written through pickIdea (the gallery's pick:
 * an outfit of exactly those garments reused, else created and named),
 * planned for its slot with planned_by 'auto', and recorded with its batch
 * and the targets it was planned for.
 */

/** The forecast a week is planned with: days by date, and the person's offset. */
export interface WeekForecast {
  days: ReadonlyMap<IsoDate, DayForecast>;
  offset: number;
}

export const NO_FORECAST: WeekForecast = { days: new Map(), offset: 0 };

/**
 * The person's forecast (a cached read, at most one bounded fetch; nothing
 * without WEATHER_ENABLED or a location). Read before any transaction: a
 * plan never holds the owner lock while Open-Meteo answers. A plan is a
 * decision made once, so "Plan my week" reads `{ fresh: true }` (a stale
 * forecast's refresh awaited, not served around); the daily re-plan reads
 * `{}` after its batch refreshed every candidate's forecast together
 * (refreshForecastsFor), so one slow location never holds up the rest.
 */
export async function weekForecast(
  deps: { db: Db; weather: WeatherService | undefined },
  userId: number,
  now: Date,
  read: ReadOptions,
): Promise<WeekForecast> {
  if (!deps.weather) return NO_FORECAST;
  const { settings, cached } = await userWeather(
    deps.db,
    deps.weather,
    userId,
    now,
    read,
  );
  return {
    days: new Map((cached?.forecast.days ?? []).map((day) => [day.day, day])),
    offset: settings.offset,
  };
}

/** The days "Plan my week" fills: today and the six after it. */
export function planDays(today: IsoDate): IsoDate[] {
  return Array.from({ length: PLAN_DAYS }, (_, i) => addDays(today, i));
}

/** An entry the planner wrote, as the calendar and plan_week report it. */
export interface PlannedEntry {
  entryId: number;
  day: IsoDate;
  occasion: Occasion;
  outfitId: number;
  outfitName: string | null;
  /** The planner found this outfit already saved and planned it (it created none). */
  alreadySaved: boolean;
  garments: { id: number; name: string | null; category: string }[];
  /** The idea's problems: a near miss the planner took for want of better. */
  problems: IdeaProblem[];
}

export interface WeekPlanResult {
  /** False: the person has no week template, so nothing was planned. */
  templateSet: boolean;
  /** The batch (for Undo); null when nothing was planned. */
  weekPlanId: number | null;
  planned: PlannedEntry[];
  /** Empty slots nothing could fill (nothing clean left for them). */
  unfilled: Slot[];
}

export interface PlanWeekInput {
  /** Today in APP_TIMEZONE. */
  today: IsoDate;
  /** Now's hour in APP_TIMEZONE (today's ended slots stay empty). */
  hour: number;
  /** The days to fill: planDays(today); the seed plans the week after its anchor. */
  days: readonly IsoDate[];
  forecast: WeekForecast;
}

/** Fills the week's empty template slots, once (see the module comment). */
export function planMyWeek(
  db: Queryable,
  ownerId: number,
  input: PlanWeekInput,
): Promise<WeekPlanResult> {
  return ownerTransaction(db, ownerId, async (tx) => {
    const template = await findWeekTemplate(tx, ownerId);
    if (template.length === 0) {
      return {
        templateSet: false,
        weekPlanId: null,
        planned: [],
        unfilled: [],
      };
    }
    const week = await readWeek(
      tx,
      ownerId,
      input.today,
      input.days[input.days.length - 1],
    );
    const plan = planWeek({
      ...week,
      hour: input.hour,
      days: input.days,
      template,
      forecast: input.forecast.days,
      offset: input.forecast.offset,
    });
    const result: WeekPlanResult = {
      templateSet: true,
      weekPlanId: null,
      planned: [],
      unfilled: plan.unfilled,
    };
    if (plan.planned.length === 0) return result;
    const weekPlanId = await createWeekPlan(tx, ownerId);
    for (const slot of plan.planned) {
      const written = await writeAutoPick(tx, ownerId, weekPlanId, {
        day: slot.day,
        occasion: slot.occasion,
        garments: slot.idea.garments,
        problems: slot.idea.problems,
        needs: plannedNeeds(slot.needs),
      });
      if (written) result.planned.push(written);
      else result.unfilled.push({ day: slot.day, occasion: slot.occasion });
    }
    if (result.planned.length > 0) result.weekPlanId = weekPlanId;
    else await deleteEmptyWeekPlan(tx, weekPlanId);
    return result;
  });
}

/**
 * What the planner and the re-plan judge a week by, read inside their
 * locked transaction: the entries from today to `last`, the pool, the saved
 * outfits and the avoided pairs. In turn, not at once: a transaction is one
 * connection, which runs one query at a time (pg deprecates queuing more).
 */
export async function readWeek(
  tx: Queryable,
  ownerId: number,
  today: IsoDate,
  last: IsoDate,
): Promise<Omit<WeekContext<WeekPoolGarment>, 'forecast' | 'offset'>> {
  const entries = await windowEntries(tx, ownerId, today, last);
  const pool = await weekPool(tx, ownerId, today);
  const saved = await savedOutfits(tx, ownerId);
  const avoid = await avoidedPairs(tx, ownerId);
  return { today, entries, pool, saved, avoid };
}

/**
 * Writes one of the planner's outfits: pickIdea plans it for the slot as
 * 'auto', and the entry is recorded in the batch with the targets it was
 * planned for. Undefined when the pick could not be the planner's: a
 * garment gone from the closet meanwhile, or the outfit found already on
 * that day (the person's entry, which stays theirs).
 */
export async function writeAutoPick(
  tx: Queryable,
  ownerId: number,
  weekPlanId: number,
  pick: {
    day: IsoDate;
    occasion: Occasion;
    garments: readonly WeekPoolGarment[];
    problems: IdeaProblem[];
    needs: PlannedNeeds | null;
  },
): Promise<PlannedEntry | undefined> {
  const picked = await pickIdea(tx, ownerId, {
    garmentIds: pick.garments.map((g) => g.id),
    plan: { day: pick.day, occasion: pick.occasion, plannedBy: 'auto' },
  });
  if (picked === 'not-found' || picked.schedule !== 'scheduled') {
    return undefined;
  }
  // Just planned: its entry is there.
  const entryId = (await entryOf(tx, ownerId, pick.day, picked.id))!.id;
  await recordAutoEntry(tx, {
    entryId,
    weekPlanId,
    outfitCreated: !picked.alreadySaved,
    needs: pick.needs,
  });
  return {
    entryId,
    day: pick.day,
    occasion: pick.occasion,
    outfitId: picked.id,
    outfitName: picked.name,
    alreadySaved: picked.alreadySaved,
    garments: pick.garments.map(({ id, name, category }) => ({
      id,
      name,
      category,
    })),
    problems: pick.problems,
  };
}

/**
 * Undo of one "Plan my week": its entries the planner still owns are
 * removed, with the outfits it created for them that nothing else holds
 * (removeAutoEntries); entries the person took over since (edited, worn)
 * stay theirs. The batch goes once it has no entry left. 'not-found' for a
 * batch that is not the owner's.
 */
export function undoWeekPlan(
  db: Queryable,
  ownerId: number,
  weekPlanId: number,
): Promise<{ entries: number; outfits: number } | 'not-found'> {
  return ownerTransaction(db, ownerId, async (tx) => {
    if (!(await weekPlanOf(tx, ownerId, weekPlanId))) return 'not-found';
    const removed = await removeAutoEntries(
      tx,
      ownerId,
      await batchAutoEntries(tx, weekPlanId),
    );
    await deleteEmptyWeekPlan(tx, weekPlanId);
    return removed;
  });
}

/** What the calendar says after "Plan my week" (`?planned=`). */
export interface PlannedBanner {
  /** Null: nothing new was planned (`?planned=none`). */
  weekPlanId: number | null;
  entries: BatchEntry[];
  /** Template slots of the next 7 days still without an outfit. */
  stillEmpty: Slot[];
}

/**
 * The banner's model: the batch's entries still on the calendar, and the
 * template slots of the next 7 days that are still empty (what the plan
 * could not fill, or what was removed since). Undefined for a batch that
 * is not the owner's (the banner is navigation state: no 404).
 */
export async function plannedBanner(
  db: Db,
  ownerId: number,
  planned: number | 'none',
  now: { today: IsoDate; hour: number },
): Promise<PlannedBanner | undefined> {
  const days = planDays(now.today);
  const [entries, template, window] = await Promise.all([
    planned === 'none' ? [] : batchEntries(db, ownerId, planned),
    findWeekTemplate(db, ownerId),
    windowEntries(db, ownerId, now.today, days[days.length - 1]),
  ]);
  if (planned !== 'none' && entries.length === 0) return undefined;
  return {
    weekPlanId: planned === 'none' ? null : planned,
    entries,
    stillEmpty: emptySlots({
      today: now.today,
      hour: now.hour,
      days,
      template,
      entries: window,
    }),
  };
}
