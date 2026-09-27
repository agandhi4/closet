import type { Db } from '../../db/client';
import type { Logger } from '../../logger';
import { DAY_OCCASIONS } from '../../wardrobe/occasions';
import {
  type NeedsChange,
  type Replan,
  replanWeek,
  type Slot,
} from '../../wardrobe/week-planner';
import { lockOwner } from '../auth/queries';
import { dayOfWeek, hourIn, todayIn } from '../calendar/calendar-date';
import { DAY_NAMES, occasionLabel } from '../calendar/labels';
import { ideaName } from '../gallery/ideas';
import type { WeekPoolGarment } from '../gallery/queries';
import { t, type StringKey } from '../i18n';
import type { PushPayload } from '../push/payload';
import { morningReminderDevices } from '../push/queries';
import type { PushSender } from '../push/sender';
import type { WeatherService } from '../weather/service';
import { readWeek, weekForecast, writeAutoPick } from './plan';
import {
  autoEntries,
  claimReplans,
  pruneReplanClaims,
  removeAutoEntries,
  updatePlannedNeeds,
} from './queries';

/**
 * The daily re-plan (#16; plan section 12): each morning the week
 * planner's own entries (planned_by 'auto', not worn, today on) are judged
 * against the day's forecast (replanWeek, src/wardrobe/week-planner.ts):
 * unchanged targets keep them; changed ones keep an outfit that still fits
 * and swap one that no longer does for a better idea; entries a person
 * planned, edited or wore are 'user' and never read here. What swapped is
 * pushed to the person's devices that take the morning reminder.
 *
 * replanWeeks is one run: server.ts schedules it every minute
 * (scheduleMinutely) with WEATHER_ENABLED, never createApp(), so the
 * integration harness and the CLIs never re-plan on their own (a spec calls
 * it with the instant it wants). A run does nothing before REPLAN_HOUR on
 * the household's wall clock (hourIn, so DST days keep 06:00 at 06:00: the
 * hour exists on every day in US and EU zones); from then on it claims
 * today's re-plan per user (claimReplans: week_replan's primary key, so a
 * user is re-planned once a day across minutes, restarts and two servers
 * overlapping in a deploy; a server down at 06:00 catches up when it
 * starts). The claim comes first: a crash mid-run skips that user until
 * tomorrow rather than pushing twice.
 */

/** The household's hour from which a day's re-plan runs: before people dress, after the night's forecast runs. */
export const REPLAN_HOUR = 6;

/** How long a push service keeps an undelivered swap: the day's, not the next's. */
const SWAP_TTL_SECONDS = 6 * 60 * 60;
/** A later swap notice replaces an unread one. */
const SWAP_TAG = 'week-replan';

export interface ReplanDeps {
  db: Db;
  weather: WeatherService;
  /** Undefined without PWA_ENABLED: swaps are made, nobody is told. */
  push: PushSender | undefined;
  timeZone: string;
  /** Context `WeekPlan`. */
  logger: Logger;
}

export interface ReplanRun {
  /** Users this run claimed (re-planned). */
  claimed: number;
  swapped: number;
  /** Entries whose targets changed and whose outfit was kept. */
  kept: number;
  failed: number;
  /** Users sent a swap notice. */
  pushed: number;
}

/** One swapped slot, for the notice. */
export interface Swap {
  slot: Slot;
  change: NeedsChange;
  /** The garments the new outfit brought in, top to toe. */
  swappedIn: string;
}

/** One minute's re-plan. Never throws for a user: each failure is logged. */
export async function replanWeeks(
  deps: ReplanDeps,
  now: Date,
): Promise<ReplanRun> {
  const run: ReplanRun = {
    claimed: 0,
    swapped: 0,
    kept: 0,
    failed: 0,
    pushed: 0,
  };
  if (hourIn(deps.timeZone, now) < REPLAN_HOUR) return run;
  const today = todayIn(deps.timeZone, now);
  const users = await claimReplans(deps.db, today, now);
  run.claimed = users.length;
  for (const userId of users) {
    const started = performance.now();
    try {
      const { swaps, kept } = await replanUser(deps, userId, now);
      run.swapped += swaps.length;
      run.kept += kept;
      const swapped = swaps
        .map((s) => `${s.slot.day} ${s.slot.occasion} ${s.change}`)
        .join(', ');
      const ms = Math.round(performance.now() - started);
      deps.logger.info(
        `Week re-plan for user ${userId} on ${today}: ${swaps.length} swapped (${swapped}), ${kept} kept in ${ms} ms`,
      );
      if (swaps.length > 0 && (await pushSwaps(deps, userId, swaps))) {
        run.pushed += 1;
      }
    } catch (error) {
      run.failed += 1;
      deps.logger.error(
        { err: error },
        `Week re-plan for user ${userId} on ${today} failed`,
      );
    }
  }
  if (run.claimed > 0) {
    deps.logger.info(
      `Week re-plan at ${now.toISOString()}: ${run.claimed} user(s), ${run.swapped} swapped, ${run.kept} kept, ${run.failed} failed, ${run.pushed} notified`,
    );
  }
  return run;
}

/**
 * Judges one user's auto entries and applies the verdicts, in one
 * transaction under lockOwner (a "Plan my week" or an outfit edit takes
 * its turn): a kept entry records its new targets; a swap plans the new
 * idea in the same batch, then removes the old entry (and the outfit the
 * planner made for it, if nothing else holds it). Its forecast is read
 * first, outside the lock.
 */
export async function replanUser(
  deps: Pick<ReplanDeps, 'db' | 'weather' | 'timeZone'>,
  userId: number,
  now: Date,
): Promise<{ swaps: Swap[]; kept: number }> {
  const today = todayIn(deps.timeZone, now);
  const forecast = await weekForecast(deps, userId, now);
  return deps.db.transaction(async (tx) => {
    await lockOwner(tx, userId);
    const auto = await autoEntries(tx, userId, today);
    if (auto.length === 0) return { swaps: [], kept: 0 };
    const week = await readWeek(tx, userId, today, auto[auto.length - 1].day);
    const replans: Replan<WeekPoolGarment>[] = replanWeek({
      ...week,
      forecast: forecast.days,
      offset: forecast.offset,
      auto: auto.map(({ entryId, plannedFor }) => ({ entryId, plannedFor })),
    });
    const autoById = new Map(auto.map((a) => [a.entryId, a]));
    const entryById = new Map(week.entries.map((e) => [e.id, e]));
    const swaps: Swap[] = [];
    let kept = 0;
    for (const replan of replans) {
      if (replan.kind === 'unchanged') continue;
      if (replan.kind === 'kept') {
        await updatePlannedNeeds(tx, replan.entryId, replan.needs);
        kept += 1;
        continue;
      }
      // The new outfit first: if it cannot be planned (a garment gone from
      // the closet meanwhile), the old one stays, under its new targets.
      const old = autoById.get(replan.entryId)!;
      const written = await writeAutoPick(tx, userId, old.weekPlanId, {
        ...replan.slot,
        garments: replan.idea.garments,
        problems: replan.idea.problems,
        needs: replan.needs,
      });
      if (!written) {
        await updatePlannedNeeds(tx, replan.entryId, replan.needs);
        kept += 1;
        continue;
      }
      await removeAutoEntries(tx, userId, [old]);
      const before = new Set(
        entryById.get(replan.entryId)!.garments.map((g) => g.id),
      );
      const brought = replan.idea.garments.filter((g) => !before.has(g.id));
      swaps.push({
        slot: replan.slot,
        change: replan.change,
        swappedIn: ideaName(
          brought.length > 0 ? brought : replan.idea.garments,
        ),
      });
    }
    return { swaps, kept };
  });
}

const CHANGE_LINES: Readonly<Record<NeedsChange, StringKey>> = {
  forecast: 'weekPlan.push.FORECAST',
  rain: 'weekPlan.push.RAIN',
  colder: 'weekPlan.push.COLDER',
  warmer: 'weekPlan.push.WARMER',
  dry: 'weekPlan.push.DRY',
  swing: 'weekPlan.push.SWING',
};

/** "Thursday", or "Thursday evening" for an occasion around the day's outfit. */
export function slotLabel(slot: Slot): string {
  const day = t(DAY_NAMES[dayOfWeek(slot.day)]);
  return DAY_OCCASIONS.includes(slot.occasion)
    ? day
    : t('weekPlan.SLOT', { day, occasion: occasionLabel(slot.occasion) });
}

/** The notice: one line per swap ("Thursday turned cold: swapped in Wool coat"). */
export function swapPayload(swaps: readonly Swap[]): PushPayload {
  return {
    title: t('weekPlan.push.TITLE'),
    body: swaps
      .map((swap) =>
        t(CHANGE_LINES[swap.change], {
          slot: slotLabel(swap.slot),
          garments: swap.swappedIn,
        }),
      )
      .join('\n'),
    url: '/calendar',
    tag: SWAP_TAG,
  };
}

/**
 * Tells the person what swapped, on the devices that take the morning
 * reminder: the swap notice is about what to wear, the reminder's
 * subject, and a device that asked for it is one that wants to hear about
 * the day's outfit. No new setting: a device without it hears nothing (the
 * calendar still shows the swap). False when nobody was told.
 */
async function pushSwaps(
  deps: ReplanDeps,
  userId: number,
  swaps: readonly Swap[],
): Promise<boolean> {
  if (!deps.push) return false;
  const devices = await morningReminderDevices(deps.db, userId);
  if (devices.length === 0) {
    deps.logger.info(
      `Week re-plan for user ${userId}: no device takes the morning reminder, nobody told`,
    );
    return false;
  }
  await deps.push.sendToDevices(userId, devices, swapPayload(swaps), {
    ttlSeconds: SWAP_TTL_SECONDS,
  });
  return true;
}

/** Removes the claims of days before `before`; server.ts calls it nightly with yesterday. */
export async function pruneReplans(
  deps: Pick<ReplanDeps, 'db' | 'logger'>,
  before: string,
): Promise<void> {
  const pruned = await pruneReplanClaims(deps.db, before);
  if (pruned > 0) {
    deps.logger.info(`Pruned ${pruned} re-plan claim(s) before ${before}`);
  }
}
