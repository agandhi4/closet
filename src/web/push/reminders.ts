import type { Db } from '../../db/client';
import type { Logger } from '../../logger';
import { endWhole, JobInterrupted } from '../../metrics/partial-failure';
import { dueReminders, type ReminderKind } from '../../push/reminders';
import { hourIn, todayIn } from '../../calendar-date';
import { abortedBy, waitUnlessAborted } from '../abort';
import { occasionLabel } from '../date-labels';
import type { DayEntry } from '../calendar/queries';
import { ideaName } from '../gallery/ideas';
import { t } from '../i18n';
import { compareOccasions } from '../../wardrobe/occasions';
import { type EveningDay, eveningDays } from '../today/queries';
import { todayFor, type TodayModel } from '../today/today';
import { TODAY_PATH } from '../today/urls';
import {
  refreshForecastsFor,
  type UserWeather,
  userWeatherOrNone,
  type WeatherService,
} from '../weather/service';
import { todayLine } from '../weather/summary';
import { weatherLineText } from '../weather/views';
import { replanCandidates } from '../week-plan/queries';
import {
  reminderSwapLine,
  type ReplanDeps,
  replanToday,
  type Swap,
} from '../week-plan/replan';
import type { PushPayload } from './payload';
import {
  claimReminders,
  pruneReminderClaims,
  releaseReminderClaims,
  reminderDevices,
} from './queries';
import type { DeviceMessage, PushSender, SendReport } from './sender';

/**
 * The push reminders (#15; plan section 9, issue #5's answer): a morning
 * "Today's outfit" and an evening "What did you wear?", each at a time the
 * device chose (opt-in per device, the profile's settings). Both open
 * Today. sendDueReminders is one run: scheduled every minute by server.ts
 * (scheduleMinutely), never by createApp(), so the integration harness
 * and the CLIs send nothing on their own; a spec calls it with the instant
 * it wants.
 *
 * A run: what is due (dueReminders, pure: the time in APP_TIMEZONE, set
 * before it, at most LATE_LIMIT_MINUTES ago), claimed in the database
 * (claimReminders: push_reminder's primary key, so two servers overlapping
 * in a deploy never both send), then composed per person and sent to the
 * claiming devices only. The morning one is composed from the same Today
 * model the page shows; the evening one names what is planned and is
 * skipped when anything is marked worn today. A claim is taken before
 * sending: a crash between the two loses that reminder rather than sending
 * it twice (the notification's tag would stack nothing, but a reminder is
 * not worth a second buzz).
 *
 * **What a run reads is per batch, not per person, where it can be**
 * (#173: production pays a round trip per statement, and a loop per person
 * multiplies it): the mornings' forecasts and who among them is due a
 * re-plan, and every evening person's day, are one statement each for the
 * whole minute (readBatch); composing stays per person (a failure is that
 * person's alone); the sends go last, together, their devices read in one
 * statement at send time (PushSender.sendEach).
 *
 * **The morning one describes the day after its re-plan** (#76): before
 * composing it, the person's re-plan for today runs if nothing has run it
 * yet (replanToday, src/web/week-plan/replan.ts, once a day per user
 * whoever asks, the claim committed with the work). So a 05:00 reminder
 * never names an outfit the day's own re-plan is about to swap, whatever
 * the two minute timers' order, and with two servers the one that loses
 * the claim waits for the other's re-plan to commit before reading. What
 * that re-plan swapped today is said in the reminder itself, first ("Swapped
 * in Wool coat: it turned cold"): one push, not a swap notice beside it;
 * other days' swaps still get the re-plan's notice.
 *
 * **A run is abortable** (`signal`, from the timer's stop(), ScheduledJob),
 * and sendDueReminders owns its claims through it. The abort cancels, it
 * never abandons (#920): the signal reaches every step (the batch's
 * forecast refresh, each morning's re-plan, src/web/abort.ts, its forecast
 * read and Today's), each stops at its next boundary (a re-plan's
 * transaction rolls back, so no swap or notice outlives its given-back
 * claim), and the run awaits the step to its end before it gives back
 * every claim not reported sent (giveBack), so the next server sends them.
 * The one step it stops waiting on is the send itself (web-push takes no
 * signal; sendAll). A send already reported is never given back. The run
 * is `interrupted` (sendDueRemindersWhole throws JobInterrupted: no
 * failure, no capture) only when every unsent claim was given back; a
 * give-back that failed or fell short lost reminders, so it is a failure
 * (`lost`). Claiming stays before composing: the server that wins the
 * claim is the one whose re-plan's swaps the reminder says, and the loser
 * composes nothing.
 */

/**
 * How long a push service keeps an undelivered reminder (Web Push TTL):
 * the morning's is still useful at lunch; the evening's must not arrive
 * the next day (the latest time is 23:00).
 */
const REMINDER_TTL_SECONDS: Readonly<Record<ReminderKind, number>> = {
  morning: 3 * 60 * 60,
  evening: 60 * 60,
};

/** Notification tags: a later reminder of a kind replaces an unread one. */
const REMINDER_TAGS: Readonly<Record<ReminderKind, string>> = {
  morning: 'today-morning',
  evening: 'today-evening',
};

export interface ReminderDeps {
  db: Db;
  sender: PushSender;
  weather: WeatherService | undefined;
  timeZone: string;
  /** Context `Push`. */
  logger: Logger;
  /** The week's re-plan, run for a person before their morning reminder. */
  replan: ReplanDeps;
  /** releaseReminderClaims; a spec stands in one that fails. */
  releaseClaims?: typeof releaseReminderClaims;
}

export interface ReminderRun {
  /** Reminders due now, sent or not (one already sent stays due for a while). */
  due: number;
  /** Claimed by this run: the ones it answers for. */
  claimed: number;
  /** People sent a reminder, and those whose evening one was skipped. */
  sent: number;
  skipped: number;
  /** People whose reminder failed, whichever step: one person counts once (markFailed). */
  failed: number;
  failedUsers: Set<number>;
  /** Claims given back unsent, for the next run (giveBack). */
  released: number;
  /** Unsent claims a give-back could not release: those reminders are lost (a failure). */
  lost: number;
  /** Shutdown stopped the run and every unsent claim was given back. */
  interrupted: boolean;
}

/** `run.failed` counts people, so a failed re-plan and a failed send of one person are one. */
function markFailed(run: ReminderRun, userId: number): void {
  run.failedUsers.add(userId);
  run.failed = run.failedUsers.size;
}

/** One person's reminder of one kind, to the devices that claimed it. */
interface ReminderGroup {
  userId: number;
  kind: ReminderKind;
  deviceIds: number[];
  /** This run's claims behind it: released if it cannot be sent (sendAll). */
  claims: ClaimedReminder[];
}

type ClaimedReminder = Awaited<ReturnType<typeof claimReminders>>[number];

/** A composed reminder and the claims it answers for. */
interface ComposedReminder {
  message: DeviceMessage;
  claims: readonly ClaimedReminder[];
}

/** What the run read once for all its people (readBatch). */
interface ReminderBatch {
  /** The mornings' weather, refreshed together; a person missing reads their own. */
  weather: ReadonlyMap<number, UserWeather>;
  /** The mornings' people due today's re-plan (replanCandidates). */
  replans: ReadonlySet<number>;
  /** The evenings' people's day. */
  evenings: ReadonlyMap<number, EveningDay>;
}

/** One minute's reminders. Never throws for a person: each failure is logged and counted (sendDueRemindersWhole throws for them). */
export async function sendDueReminders(
  deps: ReminderDeps,
  now: Date,
  signal?: AbortSignal,
): Promise<ReminderRun> {
  const { db, logger } = deps;
  const due = dueReminders(await reminderDevices(db), now, deps.timeZone);
  const run: ReminderRun = {
    due: due.length,
    claimed: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    failedUsers: new Set(),
    released: 0,
    lost: 0,
    interrupted: false,
  };
  if (due.length === 0) return run;
  const claimed = await claimReminders(db, due, now);
  run.claimed = claimed.length;
  if (claimed.length === 0) return run;

  const answered = new Set<ClaimedReminder>();
  try {
    await composeAndSend(deps, due, claimed, now, run, answered, signal);
  } catch (error) {
    if (!abortedBy(signal, error)) throw error;
    // Every step has settled here: nothing of this run runs on.
    const unsent = claimed.filter((claim) => !answered.has(claim));
    logger.warn(
      `Shutdown stopped the reminder run; giving back ${unsent.length} of ${claimed.length} claim(s)`,
    );
    await giveBack(deps, unsent, run);
    run.interrupted = run.lost === 0;
  }
  logger.info(
    `Reminders at ${now.toISOString()}: ${run.claimed} claimed of ${run.due} due, ${run.sent} sent, ${run.skipped} skipped, ${run.failed} failed${run.lost > 0 ? `, ${run.lost} lost` : ''}${run.interrupted ? ', interrupted' : ''}`,
  );
  return run;
}

/**
 * Everything after the claim: group, read the batch, compose, send. Throws
 * `signal`'s reason at the first step boundary after it aborts, each step
 * it started awaited to its end; `answered` collects the claims whose send
 * was reported, which sendDueReminders never gives back.
 */
async function composeAndSend(
  deps: ReminderDeps,
  due: readonly { deviceId: number; userId: number }[],
  claimed: readonly ClaimedReminder[],
  now: Date,
  run: ReminderRun,
  answered: Set<ClaimedReminder>,
  signal: AbortSignal | undefined,
): Promise<void> {
  const { logger } = deps;
  // One notification per person and kind, to the devices that claimed it.
  const userOf = new Map(due.map((d) => [d.deviceId, d.userId]));
  const groups = new Map<string, ReminderGroup>();
  for (const claim of claimed) {
    const { deviceId, kind } = claim;
    const userId = userOf.get(deviceId)!;
    const key = `${userId}:${kind}`;
    const group = groups.get(key) ?? {
      userId,
      kind,
      deviceIds: [],
      claims: [],
    };
    group.deviceIds.push(deviceId);
    group.claims.push(claim);
    groups.set(key, group);
  }
  signal?.throwIfAborted();
  const batch = await readBatch(deps, [...groups.values()], now, signal);
  const composed: ComposedReminder[] = [];
  for (const { userId, kind, deviceIds, claims } of groups.values()) {
    // Logged before sending: a claim is never retried (claim before send, so
    // a crash loses a reminder rather than doubling it), and this line is
    // what tells a lost reminder apart from one that was never due.
    logger.info(
      `Claimed the ${kind} reminder for user ${userId}, devices ${deviceIds.join(', ')}`,
    );
    try {
      signal?.throwIfAborted();
      const payload =
        kind === 'morning'
          ? await morningPayload(deps, userId, now, batch, run, signal)
          : eveningPayload(batch.evenings.get(userId));
      if (!payload) {
        run.skipped += 1;
        logger.info(
          `Evening reminder for user ${userId} skipped: something is marked worn today`,
        );
        continue;
      }
      composed.push({
        message: {
          userId,
          devices: deviceIds,
          payload,
          options: { ttlSeconds: REMINDER_TTL_SECONDS[kind] },
        },
        claims,
      });
    } catch (error) {
      if (abortedBy(signal, error)) throw error;
      markFailed(run, userId);
      logger.error(
        { err: error },
        `The ${kind} reminder for user ${userId} failed`,
      );
    }
  }
  await sendAll(deps, composed, run, answered, signal);
}

/**
 * The scheduled run: sendDueReminders, then a PartialFailure when a person
 * or the batch failed (the others were sent first), for `timeJob` to record
 * as `failure` (#687). server.ts only; a spec asserting who was sent calls
 * sendDueReminders.
 */
export async function sendDueRemindersWhole(
  deps: ReminderDeps,
  now: Date,
  signal?: AbortSignal,
): Promise<ReminderRun> {
  const run = await sendDueReminders(deps, now, signal);
  // A person's real failure (a refused send, a failed compose) and a
  // give-back that lost reminders still alert when shutdown cut the run
  // short: only the interruption is not one.
  endWhole('reminders', { failed: run.failed, lost: run.lost }, run);
  if (run.interrupted) throw new JobInterrupted('reminders');
  return run;
}

/**
 * What the run's people need beside their own model, read once for all of
 * them and at once (independent reads, so their round trips overlap): the
 * mornings' forecasts, refreshed together before anyone's re-plan or
 * weather line reads them (each read after is a refreshed row or the stale
 * one, never a person's own wait on Open-Meteo in turn), who among the
 * mornings is due today's re-plan, and the evenings' days.
 */
async function readBatch(
  deps: ReminderDeps,
  groups: readonly ReminderGroup[],
  now: Date,
  signal: AbortSignal | undefined,
): Promise<ReminderBatch> {
  const today = todayIn(deps.timeZone, now);
  const of = (kind: ReminderKind) =>
    groups.filter((group) => group.kind === kind).map((group) => group.userId);
  const mornings = of('morning');
  const evenings = of('evening');
  const weather =
    deps.weather && mornings.length > 0
      ? refreshForecastsFor(
          { db: deps.db, weather: deps.weather, logger: deps.logger },
          mornings,
          now,
          signal,
        )
      : Promise.resolve(new Map<number, UserWeather>());
  const replans = replanCandidates(deps.db, today, mornings);
  const days = eveningDays(deps.db, evenings, today);
  // All settled before any rejection is passed on: an aborted refresh must
  // not leave the reads running past the run.
  await Promise.allSettled([weather, replans, days]);
  return {
    weather: await weather,
    replans: new Set(await replans),
    evenings: await days,
  };
}

/**
 * The composed reminders, sent together (their devices read in one
 * statement, at send time: a device revoked or moved to another account
 * since the claim gets nothing). The sender never throws for a device;
 * only that one read can fail, and then nothing was sent, so the claims
 * behind these messages are given back (giveBack): the next minute finds
 * them due again and sends them. Without that one failed read (a dropped
 * connection) would lose the whole minute's reminders. Counted as failed
 * for this run either way.
 *
 * Aborted (`signal`) before the send, nothing goes out; mid-send the run
 * stops waiting on the batch, the one step it does not await to its end:
 * web-push takes no signal, and a device's request is bounded only by its
 * 10 s socket timeout, past the abort's grace. The batch touches only its
 * own reports after that, never `run`. Either way it throws the signal's
 * reason for sendDueReminders to give back what `answered` (the claims of
 * messages `sendEach` reported, `onReport`) does not hold. A send that is
 * out but unreported is given back too, so the rare device may get a
 * repeat, which the notification's tag replaces.
 */
async function sendAll(
  deps: ReminderDeps,
  composed: readonly ComposedReminder[],
  run: ReminderRun,
  answered: Set<ClaimedReminder>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (composed.length === 0) return;
  const reported = new Map<number, SendReport>();
  const send = () => {
    const sending = deps.sender.sendEach(
      composed.map((c) => c.message),
      {
        onReport: (index, report) => {
          composed[index].claims.forEach((claim) => answered.add(claim));
          reported.set(index, report);
        },
      },
    );
    // Abandoned sends are left to settle (or the process's end): a rejection
    // after the abort has nobody to tell.
    sending.catch(() => undefined);
    return sending;
  };
  const countReports = (reports: Iterable<[number, SendReport]>) => {
    for (const [index, report] of reports) {
      // A device the push service refused (not a gone one: those are
      // pruned) fails that person alone; the others' reminders went out
      // (the sender isolates per device, and has counted and logged it).
      if (report.failed === 0) {
        run.sent += 1;
        continue;
      }
      markFailed(run, composed[index].message.userId);
      deps.logger.error(
        `The ${composed[index].message.payload.tag ?? 'reminder'} for user ${composed[index].message.userId} reached ${report.delivered} of ${report.devices} device(s)`,
      );
    }
  };
  let reports: SendReport[];
  try {
    // Never started after the abort.
    signal?.throwIfAborted();
    reports = await waitUnlessAborted(send(), signal);
  } catch (error) {
    if (abortedBy(signal, error)) {
      countReports(reported);
      throw error;
    }
    const unsent = composed.filter((_, index) => !reported.has(index));
    for (const { message } of unsent) markFailed(run, message.userId);
    const users = unsent.map((c) => c.message.userId).join(', ');
    deps.logger.error(
      { err: error },
      `The reminders for user(s) ${users} could not be sent: their devices could not be read`,
    );
    await giveBack(
      deps,
      unsent.flatMap((c) => c.claims),
      run,
    );
    return;
  }
  countReports(reports.entries());
}

/**
 * Gives `claims` back (releaseReminderClaims) so the next run finds them
 * due again while they are within LATE_LIMIT_MINUTES. Never throws: what a
 * failed or short release kept is counted in `run.lost`, a failure.
 */
async function giveBack(
  deps: ReminderDeps,
  claims: readonly ClaimedReminder[],
  run: ReminderRun,
): Promise<void> {
  const release = deps.releaseClaims ?? releaseReminderClaims;
  try {
    const released = await release(deps.db, claims);
    run.released += released;
    deps.logger.warn(
      `Released ${released} reminder claim(s): the next run sends them while they are due`,
    );
    const short = claims.length - released;
    if (short > 0) {
      run.lost += short;
      deps.logger.error(
        `${short} of ${claims.length} reminder claim(s) were not released: those reminders are lost`,
      );
    }
  } catch (error) {
    run.lost += claims.length;
    deps.logger.error(
      { err: error },
      `${claims.length} reminder claim(s) could not be released: those reminders are lost`,
    );
  }
}

/**
 * Removes the claims of days before `before`: a claim only ever guards its
 * own day. server.ts calls it nightly with yesterday.
 */
export async function pruneReminders(
  deps: Pick<ReminderDeps, 'db' | 'logger'>,
  before: string,
): Promise<void> {
  const pruned = await pruneReminderClaims(deps.db, before);
  if (pruned > 0) {
    deps.logger.info(`Pruned ${pruned} reminder claim(s) before ${before}`);
  }
}

/**
 * The person's re-plan for today, if the batch found it due (else nothing
 * has anything to judge, or someone ran it already: the same answer the
 * re-plan's own look gives), announcing today's swaps itself: what it
 * swapped on today's entries, for the reminder to say. Throws only the
 * run's abort (replanToday): a failed re-plan is logged, and the reminder
 * names the plan as it stands.
 */
async function swappedToday(
  deps: ReminderDeps,
  userId: number,
  now: Date,
  batch: ReminderBatch,
  run: ReminderRun,
  signal: AbortSignal | undefined,
): Promise<Swap[]> {
  if (!batch.replans.has(userId)) return [];
  const outcome = await replanToday(deps.replan, userId, now, {
    announcesToday: true,
    job: 'reminders',
    listed: true,
    weather: batch.weather.get(userId),
    signal,
  });
  // The reminder reports the re-plan failures it saw first itself: the
  // minutely run's own first failure of the day is a separate one (#858).
  if (outcome.kind === 'failed' && outcome.reported) markFailed(run, userId);
  if (outcome.kind !== 'replanned') return [];
  const today = todayIn(deps.timeZone, now);
  return outcome.swaps.filter((swap) => swap.slot.day === today);
}

/**
 * The morning reminder, from Today as the page shows it after the
 * person's re-plan, saying first what that re-plan swapped today. Checks
 * `signal` between its steps (the re-plan, the weather, Today's model).
 */
async function morningPayload(
  deps: ReminderDeps,
  userId: number,
  now: Date,
  batch: ReminderBatch,
  run: ReminderRun,
  signal: AbortSignal | undefined,
): Promise<PushPayload> {
  const swapped = await swappedToday(deps, userId, now, batch, run, signal);
  signal?.throwIfAborted();
  // The line and Today's ideas share the batch's weather (refreshed first).
  const ownWeather =
    batch.weather.get(userId) ??
    (deps.weather
      ? await userWeatherOrNone(
          { db: deps.db, weather: deps.weather, logger: deps.logger },
          userId,
          now,
          signal,
        )
      : undefined);
  signal?.throwIfAborted();
  const model = await todayFor(deps, userId, now, { ownWeather });
  const outfits = [...morningIdea(model), ...plannedOutfits(model)];
  return {
    title: t('today.push.MORNING_TITLE'),
    body: [
      ...swapped.map(reminderSwapLine),
      weatherText(model, deps.timeZone, now),
      outfits.length > 0
        ? outfits.join(' · ')
        : t('today.push.MORNING_NOTHING'),
    ]
      .filter((line) => line !== null)
      .join('\n'),
    url: TODAY_PATH,
    tag: REMINDER_TAGS.morning,
  };
}

/**
 * The evening reminder, naming what is planned today; null when something
 * is already marked worn. Only the day's entries and the worn check: the
 * evening says neither the weather nor an idea, so it reads no forecast and
 * no pool (#173: Today's whole model was read for the outfits' names).
 */
function eveningPayload(
  // Undefined for an account deleted since the claim: an empty day, whose
  // message finds no device (they went with the account).
  day: EveningDay = { worn: false, entries: [] },
): PushPayload | null {
  if (day.worn) return null;
  const planned = [...day.entries]
    .sort((a, b) => compareOccasions(a.occasion, b.occasion) || a.id - b.id)
    .map(plannedLine);
  return {
    title: t('today.push.EVENING_TITLE'),
    body:
      planned.length > 0
        ? t('today.push.EVENING_PLANNED', { outfits: planned.join(' · ') })
        : t('today.push.EVENING_NOTHING'),
    url: TODAY_PATH,
    tag: REMINDER_TAGS.evening,
  };
}

// "Work: Navy suit": a planned entry, as both reminders name it.
function plannedLine(entry: Pick<DayEntry, 'occasion' | 'outfitName'>) {
  return t('today.push.PLANNED', {
    occasion: occasionLabel(entry.occasion),
    outfit: entry.outfitName || t('UNTITLED_OUTFIT'),
  });
}

// One per planned entry, in occasion order.
function plannedOutfits(model: TodayModel): string[] {
  return model.rows.flatMap((row) =>
    row.kind === 'planned'
      ? row.entries.map((entry) =>
          plannedLine({
            occasion: entry.occasion,
            outfitName: entry.outfit.name,
          }),
        )
      : [],
  );
}

// "Idea: Olive chore coat, White tee, …": the top suggestion, when the day
// has nothing planned to wear through it.
function morningIdea(model: TodayModel): string[] {
  const ideas = model.rows.find((row) => row.kind === 'ideas');
  const top = ideas?.kind === 'ideas' ? ideas.ideas[0] : undefined;
  return top ? [t('today.push.IDEA', { outfit: ideaName(top.garments) })] : [];
}

// Today's weather line as text, or null (weather off, no location, no
// forecast yet).
function weatherText(
  model: TodayModel,
  timeZone: string,
  now: Date,
): string | null {
  if (!model.weather) return null;
  const { settings, active, cached } = model.weather;
  const line =
    active &&
    cached &&
    todayLine({
      cached,
      active,
      settings,
      today: model.today,
      hour: hourIn(timeZone, now),
    });
  return line ? weatherLineText(line) : null;
}
