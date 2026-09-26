import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { userDevice } from '../../db/schema';

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
 * The endpoint belongs to whoever is signed in on that browser now.
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

/** Every device the user receives notifications on. */
export async function devicesOf(db: Db, userId: number): Promise<DeviceRow[]> {
  // user_device_user_id_index.
  return db
    .select({
      id: userDevice.id,
      pushEndpoint: userDevice.pushEndpoint,
      keyP256dh: userDevice.keyP256dh,
      keyAuth: userDevice.keyAuth,
    })
    .from(userDevice)
    .where(eq(userDevice.userId, userId))
    .orderBy(userDevice.id);
}

/** Drops a device its push service reports gone (404/410). */
export async function deleteDeviceById(db: Db, id: number): Promise<void> {
  await db.delete(userDevice).where(eq(userDevice.id, id));
}
