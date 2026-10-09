import type { Db, Queryable } from '../../db/client';
import { type ScalarValues, selectScalars } from '../../db/select-scalars';
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
  type WeekEntry,
} from '../../wardrobe/week-planner';
import type { TemplateSlot } from '../../wardrobe/week';
import type { DayForecast } from '../../weather/forecast';
import { ownerTransaction } from '../auth/queries';
import { addDays, type IsoDate } from '../../calendar-date';
import { entryOf } from '../calendar/queries';
import { pickIdea } from '../gallery/ideas';
import {
  generatorMemorySql,
  readGeneratorMemory,
  readWeekPool,
  type WeekPoolGarment,
  weekPoolSql,
} from '../gallery/queries';
import type { ReadOptions } from '../weather/location-cache';
import {
  type UserWeather,
  userWeather,
  type WeatherService,
} from '../weather/service';
import {
  type BatchEntry,
  createWeekPlan,
  deleteEmptyWeekPlan,
  recordAutoEntry,
  removeBatchAutoEntries,
  removeUnheldOutfits,
  readWindowEntries,
  weekPlanOf,
  windowEntries,
  windowEntriesSql,
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
 * forecast's refresh awaited, not served around); the daily re-plan takes
 * what its batch's refresh of every candidate's forecast answered
 * (refreshForecastsFor, forecastOf), so one slow location never holds up
 * the rest, and reads `{}` only for a user the batch left out (a failed
 * or overrun refresh) or when the morning reminder runs it.
 */
export async function weekForecast(
  deps: { db: Db; weather: WeatherService | undefined },
  userId: number,
  now: Date,
  read: ReadOptions,
): Promise<WeekForecast> {
  if (!deps.weather) return NO_FORECAST;
  return forecastOf(
    await userWeather(deps.db, deps.weather, userId, now, read),
  );
}

/** A user's weather as the week is planned with it. */
export function forecastOf({ settings, cached }: UserWeather): WeekForecast {
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
  return ownerTransaction(db, ownerId, 'planMyWeek', async (tx) => {
    const template = await findWeekTemplate(tx, ownerId);
    if (template.length === 0) {
      return {
        templateSet: false,
        weekPlanId: null,
        planned: [],
        unfilled: [],
      };
    }
    const { today, hour, days } = input;
    const entries = await windowEntries(tx, ownerId, today, days.at(-1)!);
    // Every slot filled already (a double tap, a retried plan_week, a week
    // planned by hand): nothing to plan, so neither the pool nor the
    // generator's memory is read (#165: two round trips). planWeek plans
    // exactly these slots.
    if (emptySlots({ today, hour, days, template, entries }).length === 0) {
      return { templateSet: true, weekPlanId: null, planned: [], unfilled: [] };
    }
    const plan = planWeek({
      today,
      entries,
      ...(await readGenerator(tx, ownerId, today)),
      hour,
      days,
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
 * What the re-plan judges a week by, as scalar subqueries for one
 * selectScalars inside its locked transaction: the entries from today to
 * `last` and what the generator draws from (generatorSql). The re-plan
 * reads its auto entries' outfit states in the same statement (#173: they
 * were four); readWeekColumns reads them back.
 */
export function weekSql(ownerId: number, today: IsoDate, last: IsoDate) {
  return {
    entries: windowEntriesSql(ownerId, today, last),
    ...generatorSql(ownerId, today),
  };
}

export function readWeekColumns(
  today: IsoDate,
  row: ScalarValues<ReturnType<typeof weekSql>>,
): Omit<WeekContext<WeekPoolGarment>, 'forecast' | 'offset'> {
  return {
    today,
    entries: readWindowEntries(row.entries),
    ...readGeneratorColumns(row),
  };
}

/**
 * The pool and the saved outfits with the avoided pairs: what the planner
 * fills slots from, as scalar subqueries (the generator's own, in
 * src/web/gallery/queries.ts).
 */
function generatorSql(ownerId: number, today: IsoDate) {
  return {
    pool: weekPoolSql(ownerId, today),
    ...generatorMemorySql(ownerId),
  };
}

function readGeneratorColumns(
  row: ScalarValues<ReturnType<typeof generatorSql>>,
): Pick<WeekContext<WeekPoolGarment>, 'pool' | 'saved' | 'avoid'> {
  return { pool: readWeekPool(row.pool), ...readGeneratorMemory(row) };
}

/** generatorSql in one statement: "Plan my week" once it found a slot to fill. */
async function readGenerator(
  tx: Queryable,
  ownerId: number,
  today: IsoDate,
): Promise<Pick<WeekContext<WeekPoolGarment>, 'pool' | 'saved' | 'avoid'>> {
  return readGeneratorColumns(
    await selectScalars(tx, generatorSql(ownerId, today)),
  );
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
 * removed (removeBatchAutoEntries), with the outfits it created for them
 * that nothing else holds (removeUnheldOutfits); entries the person took
 * over since (edited, worn) stay theirs. The batch goes once it has no
 * entry left. 'not-found' for a batch that is not the owner's.
 */
export function undoWeekPlan(
  db: Queryable,
  ownerId: number,
  weekPlanId: number,
): Promise<{ entries: number; outfits: number } | 'not-found'> {
  return ownerTransaction(db, ownerId, 'undoWeekPlan', async (tx) => {
    const removed = await removeBatchAutoEntries(tx, ownerId, weekPlanId);
    // Nothing removed: an own batch whose entries were all taken over (or
    // undone already), or not the owner's at all. Only then is it asked.
    if (removed.length === 0 && !(await weekPlanOf(tx, ownerId, weekPlanId))) {
      return 'not-found';
    }
    const outfits = await removeUnheldOutfits(
      tx,
      ownerId,
      removed.filter((e) => e.outfitCreated).map((e) => e.outfitId),
    );
    await deleteEmptyWeekPlan(tx, weekPlanId);
    return { entries: removed.length, outfits };
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
 * is not the owner's (the banner is navigation state: no 404). From reads
 * the caller made (weekContext, src/web/calendar/week-context.ts: the
 * batch's entries, the template, and the entries of planDays(today), in
 * the week page's one statement).
 */
export function plannedBanner(
  planned: number | 'none',
  reads: {
    batch: BatchEntry[];
    template: readonly TemplateSlot[];
    window: readonly Pick<WeekEntry, 'day' | 'occasion'>[];
  },
  now: { today: IsoDate; hour: number },
): PlannedBanner | undefined {
  if (planned !== 'none' && reads.batch.length === 0) return undefined;
  return {
    weekPlanId: planned === 'none' ? null : planned,
    entries: reads.batch,
    stillEmpty: emptySlots({
      today: now.today,
      hour: now.hour,
      days: planDays(now.today),
      template: reads.template,
      entries: reads.window,
    }),
  };
}
