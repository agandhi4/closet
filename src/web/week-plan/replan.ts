import type { Db, Queryable } from '../../db/client';
import type { Logger } from '../../logger';
import { REMINDER_WINDOWS } from '../../push/reminders';
import { DAY_OCCASIONS } from '../../wardrobe/occasions';
import {
  type NeedsChange,
  type Replan,
  replanWeek,
  type Slot,
  type SwapCause,
  type Unwearable,
  unwearableOn,
} from '../../wardrobe/week-planner';
import { OwnerLockTimeout, ownerTransaction } from '../auth/queries';
import {
  dayOfWeek,
  hourIn,
  type IsoDate,
  todayIn,
} from '../calendar/calendar-date';
import { DAY_NAMES, occasionLabel } from '../calendar/labels';
import { ideaName } from '../gallery/ideas';
import type { WeekPoolGarment } from '../gallery/queries';
import { t, type StringKey } from '../i18n';
import type { PushPayload } from '../push/payload';
import { morningReminderDevices } from '../push/queries';
import type { PushSender } from '../push/sender';
import { refreshForecastsFor, type WeatherService } from '../weather/service';
import { readWeek, weekForecast, writeAutoPick } from './plan';
import {
  autoEntries,
  type AutoEntryRow,
  claimReplan,
  outfitGarmentStates,
  pruneReplanClaims,
  removeAutoEntries,
  replanCandidates,
  type SlotGarment,
  updatePlannedNeeds,
} from './queries';

/**
 * The daily re-plan (#16; plan section 12): each morning the week
 * planner's own entries (planned_by 'auto', not worn, today on) are judged
 * again (replanWeek, src/wardrobe/week-planner.ts): an outfit that can no
 * longer be worn on its day (a garment lent, at repair, archived or
 * deleted, or today without a clean copy: unwearableOn) is swapped for the
 * slot's best idea; one whose forecast changed is kept while it still fits
 * and swapped for a better idea when it does not. Entries a person planned,
 * edited or wore are 'user' and never read here. What swapped is pushed to
 * the person's devices that take the morning reminder.
 *
 * replanToday is one user's re-plan for the day, once: the minutely run
 * (replanWeeks) calls it for every user due one from REPLAN_HOUR, and the
 * morning reminder (src/web/push/reminders.ts) calls it for its user
 * before describing the day, so a reminder always names the plan after
 * the re-plan, whatever time it is set to (#76). "Once" is week_replan's
 * primary key, claimed inside the work's own transaction under lockOwner
 * (claimReplan): a second caller (another minute, the reminder, a second
 * server in an overlapping deploy) waits on the owner lock and finds the
 * day claimed and the re-plan committed, never half done. server.ts
 * schedules the run, never createApp(), so the integration harness and the
 * CLIs never re-plan on their own (a spec calls it with the instant it
 * wants).
 */

/**
 * The household's hour from which the minutely run re-plans: the earliest
 * a morning reminder can be set to (REMINDER_WINDOWS), so everyone's day is
 * re-planned by the time any reminder could go out, and a swap notice comes
 * before the reminder rather than after it. The reminder does not rely on
 * it (it re-plans its user first); this is for the people without one.
 * Derived, not a second constant: moving the window moves it. On the wall
 * clock (hourIn): the window keeps away from the hours DST skips.
 */
export const REPLAN_HOUR = Math.floor(REMINDER_WINDOWS.morning.from / 60);

/** How long a push service keeps an undelivered swap: the day's, not the next's. */
const SWAP_TTL_SECONDS = 6 * 60 * 60;
/** A later swap notice replaces an unread one. */
const SWAP_TAG = 'week-replan';

export interface ReplanDeps {
  db: Db;
  /** Undefined without WEATHER_ENABLED: only availability is judged. */
  weather: WeatherService | undefined;
  /** Undefined without PWA_ENABLED: swaps are made, nobody is told. */
  push: PushSender | undefined;
  timeZone: string;
  /** Context `WeekPlan`. */
  logger: Logger;
}

export interface ReplanRun {
  /** Users this run re-planned (claimed), failed ones included. */
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
  cause: SwapCause;
  /** The garment the cause names ("Bean Boots"); null for the weather or a deleted garment. */
  garment: string | null;
  /** The garments the new outfit brought in, top to toe. */
  swappedIn: string;
}

/** What replanToday did for one user. */
export type ReplanOutcome =
  | { kind: 'replanned'; swaps: Swap[]; kept: number; pushed: boolean }
  /** Nothing to do: re-planned today already (here or elsewhere), or no auto entry. */
  | { kind: 'skipped' }
  /** Logged, and the day claimed: not tried again until tomorrow. */
  | { kind: 'failed' }
  /**
   * Another of the owner's writes held the owner lock past its timeout:
   * nothing judged, logged, the day left unclaimed for the next minute.
   */
  | { kind: 'deferred' };

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
  const candidates = await replanCandidates(deps.db, today);
  if (deps.weather && candidates.length > 0) {
    await refreshForecastsFor(
      { db: deps.db, weather: deps.weather, logger: deps.logger },
      candidates,
      now,
    );
  }
  for (const userId of candidates) {
    const outcome = await replanToday(deps, userId, now);
    if (outcome.kind === 'skipped' || outcome.kind === 'deferred') continue;
    run.claimed += 1;
    if (outcome.kind === 'failed') {
      run.failed += 1;
      continue;
    }
    run.swapped += outcome.swaps.length;
    run.kept += outcome.kept;
    if (outcome.pushed) run.pushed += 1;
  }
  if (run.claimed > 0) {
    deps.logger.info(
      `Week re-plan at ${now.toISOString()}: ${run.claimed} user(s), ${run.swapped} swapped, ${run.kept} kept, ${run.failed} failed, ${run.pushed} notified`,
    );
  }
  return run;
}

/**
 * `userId`'s re-plan for today, once a day whoever asks (see the module
 * comment): the judgement and its writes in one transaction with the
 * day's claim, then the swap notice. With `announcesToday` (the morning
 * reminder, which names today's swaps in its own text) the notice leaves
 * today's swaps out and goes only for other days': one push per swap,
 * never two. The returned swaps are all of them, today's included. Never
 * throws: a failure is logged and the day claimed all the same, so it is
 * not retried every minute; only an owner lock timeout leaves the day
 * unclaimed, for the next minute.
 */
export async function replanToday(
  deps: ReplanDeps,
  userId: number,
  now: Date,
  { announcesToday = false }: { announcesToday?: boolean } = {},
): Promise<ReplanOutcome> {
  const today = todayIn(deps.timeZone, now);
  const started = performance.now();
  try {
    // A cheap look first: the forecast read below is for users with
    // something to judge. The claim decides.
    if ((await replanCandidates(deps.db, today, userId)).length === 0) {
      return { kind: 'skipped' };
    }
    const result = await replanUser(deps, userId, now);
    if (!result) return { kind: 'skipped' };
    const { swaps, kept } = result;
    const swapped = swaps
      .map((s) => `${s.slot.day} ${s.slot.occasion} ${causeText(s.cause)}`)
      .join(', ');
    const ms = Math.round(performance.now() - started);
    deps.logger.info(
      `Week re-plan for user ${userId} on ${today}: ${swaps.length} swapped (${swapped}), ${kept} kept in ${ms} ms`,
    );
    const unannounced = announcesToday
      ? swaps.filter((s) => s.slot.day !== today)
      : swaps;
    const pushed =
      unannounced.length > 0 && (await pushSwaps(deps, userId, unannounced));
    return { kind: 'replanned', swaps, kept, pushed };
  } catch (error) {
    // Another of the owner's writes held the lock past its timeout: nothing
    // was judged, so the day stays unclaimed and the next minute tries again
    // (claiming it would wait on the same lock).
    if (error instanceof OwnerLockTimeout) {
      deps.logger.warn(
        `Week re-plan for user ${userId} on ${today} deferred: ${error.logDetail}`,
      );
      return { kind: 'deferred' };
    }
    deps.logger.error(
      { err: error },
      `Week re-plan for user ${userId} on ${today} failed`,
    );
    await claimAfterFailure(deps, userId, today, now);
    return { kind: 'failed' };
  }
}

// The failed transaction took its claim with it: claim the day on its own.
async function claimAfterFailure(
  deps: ReplanDeps,
  userId: number,
  today: IsoDate,
  now: Date,
): Promise<void> {
  try {
    await ownerTransaction(deps.db, userId, 'claimAfterFailure', (tx) =>
      claimReplan(tx, userId, today, now),
    );
  } catch (error) {
    deps.logger.error(
      { err: error },
      `Week re-plan for user ${userId} on ${today} could not be claimed after its failure: tried again next minute`,
    );
  }
}

/**
 * Judges one user's auto entries and applies the verdicts, in one
 * transaction under the owner lock (every calendar write takes it: a
 * "Plan my week", a pick, scheduling, a worn tap, a delete or an outfit
 * edit waits for the re-plan or the re-plan for it, so no entry turns the
 * person's between the judgement and the swap) that also claims the day:
 * undefined when there is no auto entry (nothing claimed: a week planned
 * later today is judged by a later run) or the day was claimed already. A kept entry records its new
 * targets; a swap plans the new idea in the same batch, then removes the
 * old entry (and the outfit the planner made for it, if nothing else holds
 * it). Its forecast is read first, outside the lock.
 */
async function replanUser(
  deps: Pick<ReplanDeps, 'db' | 'weather' | 'timeZone' | 'logger'>,
  userId: number,
  now: Date,
): Promise<{ swaps: Swap[]; kept: number } | undefined> {
  const today = todayIn(deps.timeZone, now);
  // Not `fresh`: its callers (the minutely run, the morning reminder)
  // refreshed their batch's forecasts together first (refreshForecastsFor).
  // Read before the owner lock: a network wait must never hold it.
  const forecast = await weekForecast(deps, userId, now, {});
  return ownerTransaction(deps.db, userId, 'replanUser', async (tx) => {
    const auto = await autoEntries(tx, userId, today);
    if (auto.length === 0) return undefined;
    if (!(await claimReplan(tx, userId, today, now))) return undefined;
    const week = await readWeek(tx, userId, today, auto[auto.length - 1].day);
    const outfits = await outfitGarmentStates(
      tx,
      auto.map((a) => a.outfitId),
      today,
    );
    const judged = auto.map((a) => {
      const slots = outfits.get(a.outfitId) ?? [];
      const { day, outfitCreated } = a;
      const unwearable = unwearableOn({ day, outfitCreated, slots }, today);
      return { ...a, slots, unwearable };
    });
    const replans = replanWeek({
      ...week,
      forecast: forecast.days,
      offset: forecast.offset,
      auto: judged.map(({ entryId, plannedFor, unwearable }) => ({
        entryId,
        plannedFor,
        unwearable,
      })),
    });
    const autoById = new Map(judged.map((a) => [a.entryId, a]));
    const entryById = new Map(week.entries.map((e) => [e.id, e]));
    const swaps: Swap[] = [];
    let kept = 0;
    for (const replan of replans) {
      const old = autoById.get(replan.entryId)!;
      if (replan.kind !== 'swap' && old.unwearable) {
        deps.logger.info(
          `Week re-plan for user ${userId}: entry ${old.entryId} on ${old.day} cannot be worn (${unwearableText(old.unwearable)}) and nothing else dresses its slot; kept`,
        );
      }
      if (replan.kind === 'unchanged') continue;
      const swap =
        replan.kind === 'swap' &&
        (await applySwap(tx, userId, replan, {
          ...old,
          garments: entryById.get(old.entryId)!.garments,
        }));
      if (swap) {
        swaps.push(swap);
        continue;
      }
      // Kept (or a swap that could not be written): its new targets are
      // what it is judged against next.
      if (replan.needs) {
        await updatePlannedNeeds(tx, replan.entryId, replan.needs);
      }
      kept += 1;
    }
    return { swaps, kept };
  });
}

/**
 * Plans the swap's idea in the old entry's batch, then removes the old
 * entry (and the outfit the planner made for it, if nothing else holds
 * it). The new outfit first: undefined when it cannot be planned (a garment
 * gone from the closet meanwhile), and the old entry stays.
 */
async function applySwap(
  tx: Queryable,
  userId: number,
  replan: Extract<Replan<WeekPoolGarment>, { kind: 'swap' }>,
  old: AutoEntryRow & {
    garments: readonly { id: number }[];
    slots: readonly (SlotGarment | null)[];
  },
): Promise<Swap | undefined> {
  const written = await writeAutoPick(tx, userId, old.weekPlanId, {
    ...replan.slot,
    garments: replan.idea.garments,
    problems: replan.idea.problems,
    needs: replan.needs,
  });
  if (!written) return undefined;
  await removeAutoEntries(tx, userId, [old]);
  const before = new Set(old.garments.map((g) => g.id));
  const brought = replan.idea.garments.filter((g) => !before.has(g.id));
  return {
    slot: replan.slot,
    cause: replan.cause,
    garment: causeGarment(replan.cause, old.slots),
    swappedIn: ideaName(brought.length > 0 ? brought : replan.idea.garments),
  };
}

// The garment an unwearable outfit's cause names, by name or category, as
// the outfit's own name would ("Bean Boots", "Boots").
function causeGarment(
  cause: SwapCause,
  slots: readonly (SlotGarment | null)[],
): string | null {
  if (cause.kind !== 'unwearable' || cause.unwearable.reason === 'deleted') {
    return null;
  }
  const { garmentId } = cause.unwearable;
  const garment = slots.find((g) => g?.id === garmentId);
  return garment ? ideaName([garment]) : null;
}

// For the log: "colder", "repair garment 12", "deleted".
function causeText(cause: SwapCause): string {
  return cause.kind === 'weather'
    ? cause.change
    : unwearableText(cause.unwearable);
}

function unwearableText(unwearable: Unwearable): string {
  return unwearable.reason === 'deleted'
    ? 'deleted'
    : `${unwearable.reason} garment ${unwearable.garmentId}`;
}

const CHANGE_LINES: Readonly<Record<NeedsChange, StringKey>> = {
  forecast: 'weekPlan.push.FORECAST',
  rain: 'weekPlan.push.RAIN',
  colder: 'weekPlan.push.COLDER',
  warmer: 'weekPlan.push.WARMER',
  dry: 'weekPlan.push.DRY',
  swing: 'weekPlan.push.SWING',
};

// Why a swap happened, for a line that names the slot elsewhere: the
// morning reminder's "Swapped in Chelsea boots: Bean Boots is at repair".
const CHANGE_WHY: Readonly<Record<NeedsChange, StringKey>> = {
  forecast: 'weekPlan.why.FORECAST',
  rain: 'weekPlan.why.RAIN',
  colder: 'weekPlan.why.COLDER',
  warmer: 'weekPlan.why.WARMER',
  dry: 'weekPlan.why.DRY',
  swing: 'weekPlan.why.SWING',
};

const UNWEARABLE_WHY: Readonly<Record<Unwearable['reason'], StringKey>> = {
  lent: 'weekPlan.why.LENT',
  repair: 'weekPlan.why.REPAIR',
  archived: 'weekPlan.why.ARCHIVED',
  wishlist: 'weekPlan.why.WISHLIST',
  dirty: 'weekPlan.why.DIRTY',
  deleted: 'weekPlan.why.DELETED',
};

/**
 * Today's swap as the morning reminder says it, before the day's outfits
 * (src/web/push/reminders.ts): "Swapped in Wool coat: it turned cold".
 */
export function reminderSwapLine(swap: Swap): string {
  const why =
    swap.cause.kind === 'weather'
      ? t(CHANGE_WHY[swap.cause.change])
      : t(UNWEARABLE_WHY[swap.cause.unwearable.reason], {
          garment: swap.garment ?? '',
        });
  return t('today.push.SWAPPED', { garments: swap.swappedIn, why });
}

const UNWEARABLE_LINES: Readonly<Record<Unwearable['reason'], StringKey>> = {
  lent: 'weekPlan.push.LENT',
  repair: 'weekPlan.push.REPAIR',
  archived: 'weekPlan.push.ARCHIVED',
  wishlist: 'weekPlan.push.WISHLIST',
  dirty: 'weekPlan.push.DIRTY',
  deleted: 'weekPlan.push.DELETED',
};

/** "Thursday", or "Thursday evening" for an occasion around the day's outfit. */
export function slotLabel(slot: Slot): string {
  const day = t(DAY_NAMES[dayOfWeek(slot.day)]);
  return DAY_OCCASIONS.includes(slot.occasion)
    ? day
    : t('weekPlan.SLOT', { day, occasion: occasionLabel(slot.occasion) });
}

/**
 * The notice: one line per swap, saying why ("Thursday turned cold:
 * swapped in Wool coat", "Bean Boots is at repair: swapped in Chelsea
 * boots on Thursday").
 */
export function swapPayload(swaps: readonly Swap[]): PushPayload {
  return {
    title: t('weekPlan.push.TITLE'),
    body: swaps.map(swapLine).join('\n'),
    url: '/calendar',
    tag: SWAP_TAG,
  };
}

function swapLine(swap: Swap): string {
  const params = { slot: slotLabel(swap.slot), garments: swap.swappedIn };
  if (swap.cause.kind === 'weather') {
    return t(CHANGE_LINES[swap.cause.change], params);
  }
  return t(UNWEARABLE_LINES[swap.cause.unwearable.reason], {
    ...params,
    garment: swap.garment ?? '',
  });
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
