import type { Db } from '../../db/client';
import type { Logger } from '../../logger';
import { dueReminders, type ReminderKind } from '../../push/reminders';
import { hourIn, todayIn } from '../calendar/calendar-date';
import { occasionLabel } from '../calendar/labels';
import { ideaName } from '../gallery/ideas';
import { t } from '../i18n';
import { todayFor, type TodayModel } from '../today/today';
import { TODAY_PATH } from '../today/urls';
import { userWeather, type WeatherService } from '../weather/service';
import { todayLine } from '../weather/summary';
import { weatherLineText } from '../weather/views';
import type { PushPayload } from './payload';
import {
  claimReminders,
  pruneReminderClaims,
  reminderDevices,
} from './queries';
import type { PushSender } from './sender';

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
 * in a deploy never both send), then composed per person from the same
 * Today model the page shows and sent to the claiming devices only. The
 * evening one is skipped when anything is marked worn today. A claim is
 * taken before sending: a crash between the two loses that reminder rather
 * than sending it twice (the notification's tag would stack nothing, but a
 * reminder is not worth a second buzz).
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
}

export interface ReminderRun {
  /** Reminders due now, sent or not (one already sent stays due for a while). */
  due: number;
  /** Claimed by this run: the ones it answers for. */
  claimed: number;
  /** People sent a reminder, and those whose evening one was skipped. */
  sent: number;
  skipped: number;
  failed: number;
}

/** One minute's reminders. Never throws for a person: each failure is logged. */
export async function sendDueReminders(
  deps: ReminderDeps,
  now: Date,
): Promise<ReminderRun> {
  const { db, logger } = deps;
  const due = dueReminders(await reminderDevices(db), now, deps.timeZone);
  const run: ReminderRun = {
    due: due.length,
    claimed: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
  };
  if (due.length === 0) return run;
  const claimed = await claimReminders(db, due, now);
  run.claimed = claimed.length;
  if (claimed.length === 0) return run;

  // One notification per person and kind, to the devices that claimed it.
  const userOf = new Map(due.map((d) => [d.deviceId, d.userId]));
  const groups = new Map<
    string,
    { userId: number; kind: ReminderKind; deviceIds: number[] }
  >();
  for (const { deviceId, kind } of claimed) {
    const userId = userOf.get(deviceId)!;
    const key = `${userId}:${kind}`;
    const group = groups.get(key) ?? { userId, kind, deviceIds: [] };
    group.deviceIds.push(deviceId);
    groups.set(key, group);
  }
  for (const { userId, kind, deviceIds } of groups.values()) {
    // Logged before sending: a claim is never retried (claim before send, so
    // a crash loses a reminder rather than doubling it), and this line is
    // what tells a lost reminder apart from one that was never due.
    logger.info(
      `Claimed the ${kind} reminder for user ${userId}, devices ${deviceIds.join(', ')}`,
    );
    try {
      const payload = await reminderPayload(deps, userId, kind, now);
      if (!payload) {
        run.skipped += 1;
        logger.info(
          `Evening reminder for user ${userId} skipped: something is marked worn today`,
        );
        continue;
      }
      await deps.sender.sendToDevices(userId, deviceIds, payload, {
        ttlSeconds: REMINDER_TTL_SECONDS[kind],
      });
      run.sent += 1;
    } catch (error) {
      run.failed += 1;
      logger.error(
        { err: error },
        `The ${kind} reminder for user ${userId} failed`,
      );
    }
  }
  logger.info(
    `Reminders at ${now.toISOString()}: ${run.claimed} claimed of ${run.due} due, ${run.sent} sent, ${run.skipped} skipped, ${run.failed} failed`,
  );
  return run;
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
 * The reminder a person gets now, from Today as the page shows it; null
 * for an evening one when something is already marked worn today.
 */
export async function reminderPayload(
  deps: ReminderDeps,
  userId: number,
  kind: ReminderKind,
  now: Date,
): Promise<PushPayload | null> {
  const model = await todayFor(deps, userId, now);
  if (kind === 'evening') {
    if (model.wornToday) return null;
    const planned = plannedOutfits(model);
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
  const outfits = [...morningIdea(model), ...plannedOutfits(model)];
  const weather = await weatherText(deps, userId, now);
  return {
    title: t('today.push.MORNING_TITLE'),
    body: [
      weather,
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

// "Work: Navy suit", one per planned entry, in occasion order.
function plannedOutfits(model: TodayModel): string[] {
  return model.rows.flatMap((row) =>
    row.kind === 'planned'
      ? row.entries.map((entry) =>
          t('today.push.PLANNED', {
            occasion: occasionLabel(entry.occasion),
            outfit: entry.outfit.name || t('UNTITLED_OUTFIT'),
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
async function weatherText(
  deps: ReminderDeps,
  userId: number,
  now: Date,
): Promise<string | null> {
  if (!deps.weather) return null;
  const { settings, active, cached } = await userWeather(
    deps.db,
    deps.weather,
    userId,
    now,
  );
  const line =
    active &&
    cached &&
    todayLine({
      cached,
      active,
      settings,
      today: todayIn(deps.timeZone, now),
      hour: hourIn(deps.timeZone, now),
    });
  return line ? weatherLineText(line) : null;
}
