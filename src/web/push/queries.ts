import { and, eq, inArray, isNotNull, lt, ne, or, sql } from 'drizzle-orm';
import type { Db, Queryable } from '../../db/client';
import { pushReminder, userDevice } from '../../db/schema';
import type { IsoDate } from '../calendar/calendar-date';
import type {
  DueReminder,
  MinuteOfDay,
  ReminderDevice,
  ReminderKind,
} from '../../push/reminders';

/**
 * user_device: one row per browser push subscription, keyed by its endpoint
 * (unique across users; see the table in src/db/schema.ts).
 */

/** A browser's PushSubscription as the routes accept it (routes.tsx). */
export interface SubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface DeviceRow {
  id: number;
  pushEndpoint: string;
  keyP256dh: string;
  keyAuth: string;
}

/**
 * Stores the subscription for this user, keyed by its endpoint: a browser
 * sending it again (every signed-in app start), with renewed keys, or signed
 * in as another account updates the one row instead of colliding with it.
 * The endpoint belongs to whoever is signed in on that browser now; its
 * reminders were the previous account's choice, so a move turns them off
 * (reminders are opt-in per device and per person).
 */
export async function upsertDevice(
  db: Db,
  userId: number,
  subscription: SubscriptionInput,
  userAgent: string | undefined,
): Promise<number> {
  const values = {
    userId,
    pushEndpoint: subscription.endpoint,
    keyP256dh: subscription.keys.p256dh,
    keyAuth: subscription.keys.auth,
    userAgent: userAgent ?? null,
  };
  const [row] = await db
    .insert(userDevice)
    .values(values)
    .onConflictDoUpdate({
      target: userDevice.pushEndpoint,
      set: {
        userId: values.userId,
        keyP256dh: values.keyP256dh,
        keyAuth: values.keyAuth,
        userAgent: values.userAgent,
        updatedAt: sql`now()`,
        morningReminder: sql`case when ${userDevice.userId} = excluded.user_id then ${userDevice.morningReminder} end`,
        eveningReminder: sql`case when ${userDevice.userId} = excluded.user_id then ${userDevice.eveningReminder} end`,
        remindersSetAt: sql`case when ${userDevice.userId} = excluded.user_id then ${userDevice.remindersSetAt} end`,
      },
    })
    .returning({ id: userDevice.id });
  return row.id;
}

/**
 * Removes this user's row for the endpoint; another user's is left alone.
 * Returns whether there was one.
 */
export async function deleteDevice(
  db: Db,
  userId: number,
  endpoint: string,
): Promise<boolean> {
  const rows = await db
    .delete(userDevice)
    .where(
      and(eq(userDevice.userId, userId), eq(userDevice.pushEndpoint, endpoint)),
    )
    .returning({ id: userDevice.id });
  return rows.length > 0;
}

/**
 * Every device the user receives notifications on, or only those of `ids`
 * among them (a reminder goes to the devices that chose its time).
 */
export async function devicesOf(
  db: Db,
  userId: number,
  ids?: readonly number[],
): Promise<DeviceRow[]> {
  // user_device_user_id_index.
  return db
    .select({
      id: userDevice.id,
      pushEndpoint: userDevice.pushEndpoint,
      keyP256dh: userDevice.keyP256dh,
      keyAuth: userDevice.keyAuth,
    })
    .from(userDevice)
    .where(
      and(
        eq(userDevice.userId, userId),
        ids ? inArray(userDevice.id, [...ids]) : undefined,
      ),
    )
    .orderBy(userDevice.id);
}

/**
 * The one remover of an account's devices when its sessions are revoked: a
 * signed-out device receives nobody's notifications, and a device signed
 * out away from itself would otherwise keep getting the account's reminders
 * (which name planned outfits on its lock screen) until its push service
 * said 410. `keep` is the endpoint of the device making the change (the
 * change-password form posts it), which stays signed in and keeps its row
 * and reminders; an endpoint that is not one of this user's keeps nothing.
 * Callers: updatePasswordHash (the change-password route and
 * `user:set-password`, in the password's own transaction) and
 * `push:revoke-all` (after an ACCESS_TOKEN_SECRET rotation). The devices'
 * reminder claims go with them (push_reminder cascades). Returns how many
 * were removed.
 */
export async function revokeDevices(
  tx: Queryable,
  userId: number,
  keep?: string,
): Promise<number> {
  // user_device_user_id_index.
  const removed = await tx
    .delete(userDevice)
    .where(
      and(
        eq(userDevice.userId, userId),
        keep === undefined ? undefined : ne(userDevice.pushEndpoint, keep),
      ),
    )
    .returning({ id: userDevice.id });
  return removed.length;
}

/** The users with at least one device: whose `push:revoke-all` revokes. */
export async function usersWithDevices(tx: Queryable): Promise<number[]> {
  const rows = await tx
    .selectDistinct({ userId: userDevice.userId })
    .from(userDevice)
    .orderBy(userDevice.userId);
  return rows.map((row) => row.userId);
}

/** Drops a device its push service reports gone (404/410). */
export async function deleteDeviceById(db: Db, id: number): Promise<void> {
  await db.delete(userDevice).where(eq(userDevice.id, id));
}

/** A device's reminder times; null when off. */
export interface ReminderSettings {
  morning: MinuteOfDay | null;
  evening: MinuteOfDay | null;
}

/**
 * The reminders of this user's device at `endpoint` (the browser names its
 * own subscription), or undefined when the endpoint is not one of theirs:
 * never registered, removed, or signed in as someone else since.
 */
export async function findReminderSettings(
  db: Db,
  userId: number,
  endpoint: string,
): Promise<ReminderSettings | undefined> {
  const [row] = await db
    .select({
      morning: userDevice.morningReminder,
      evening: userDevice.eveningReminder,
    })
    .from(userDevice)
    .where(
      and(eq(userDevice.userId, userId), eq(userDevice.pushEndpoint, endpoint)),
    );
  return row;
}

/**
 * The one writer of a device's reminders: saves both times (null turns one
 * off) on this user's device at `endpoint`, stamped `now`, so a reminder
 * whose time has passed today first goes out tomorrow (dueReminders). The
 * device id when saved; undefined when the endpoint is not one of theirs.
 */
export async function saveReminderSettings(
  db: Db,
  userId: number,
  endpoint: string,
  settings: ReminderSettings,
  now: Date,
): Promise<number | undefined> {
  const [row] = await db
    .update(userDevice)
    .set({
      morningReminder: settings.morning,
      eveningReminder: settings.evening,
      remindersSetAt: now,
    })
    .where(
      and(eq(userDevice.userId, userId), eq(userDevice.pushEndpoint, endpoint)),
    )
    .returning({ id: userDevice.id });
  return row?.id;
}

/** Every device with a reminder on, for the scheduler (a household's handful: no index). */
export function reminderDevices(db: Db): Promise<ReminderDevice[]> {
  return db
    .select({
      id: userDevice.id,
      userId: userDevice.userId,
      morning: userDevice.morningReminder,
      evening: userDevice.eveningReminder,
      setAt: userDevice.remindersSetAt,
    })
    .from(userDevice)
    .where(
      or(
        isNotNull(userDevice.morningReminder),
        isNotNull(userDevice.eveningReminder),
      ),
    );
}

/**
 * The user's devices with the morning reminder on: the week re-plan's
 * swap notice goes to them (src/web/week-plan/replan.ts). user_device_user_id_index.
 */
export async function morningReminderDevices(
  db: Db,
  userId: number,
): Promise<number[]> {
  const rows = await db
    .select({ id: userDevice.id })
    .from(userDevice)
    .where(
      and(eq(userDevice.userId, userId), isNotNull(userDevice.morningReminder)),
    )
    .orderBy(userDevice.id);
  return rows.map((row) => row.id);
}

/**
 * Claims the due reminders for this process to send, in one statement:
 * each is inserted into push_reminder unless a row for its device, kind and
 * day exists, and only the inserted ones come back. Two servers claiming
 * the same reminder at once (an overlapping deploy) each insert; Postgres
 * makes the second wait on the first's primary key and then skip it, so
 * exactly one of them sends. A device deleted meanwhile fails the foreign
 * key and takes the whole claim with it: the next minute claims the rest.
 */
export async function claimReminders(
  db: Db,
  due: readonly DueReminder[],
  now: Date,
): Promise<{ deviceId: number; kind: ReminderKind; day: IsoDate }[]> {
  if (due.length === 0) return [];
  return db
    .insert(pushReminder)
    .values(
      due.map(({ deviceId, kind, day }) => ({
        deviceId,
        kind,
        day,
        claimedAt: now,
      })),
    )
    .onConflictDoNothing({
      target: [pushReminder.deviceId, pushReminder.kind, pushReminder.day],
    })
    .returning({
      deviceId: pushReminder.deviceId,
      kind: pushReminder.kind,
      day: pushReminder.day,
    });
}

/** Removes claims for days before `before`: they only ever guard today. */
export async function pruneReminderClaims(
  db: Db,
  before: IsoDate,
): Promise<number> {
  const deleted = await db
    .delete(pushReminder)
    .where(lt(pushReminder.day, before))
    .returning({ deviceId: pushReminder.deviceId });
  return deleted.length;
}
