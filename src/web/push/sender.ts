import webpush from 'web-push';
import type { Db } from '../../db/client';
import type { WebLogger } from '../logger';
import type { PushPayload } from './payload';
import { deleteDeviceById, type DeviceRow, devicesOf } from './queries';

/** VAPID identity (PUBLIC_VAPID_KEY, PRIVATE_VAPID_KEY, SITE_URL as subject). */
export interface VapidConfig {
  subject: string;
  publicKey: string;
  privateKey: string;
}

export interface SendOptions {
  /**
   * How long the push service keeps the message for a device that is off
   * (Web Push TTL). Past it the message is dropped: a reminder about today
   * must not arrive tomorrow.
   */
  ttlSeconds: number;
}

/** What happened to one send, per device. */
export interface SendReport {
  devices: number;
  delivered: number;
  /** Devices the push service reported gone (404/410), now deleted. */
  pruned: number;
  failed: number;
}

export interface PushSender {
  /**
   * Sends the payload to every device of the user. Never throws for a
   * device: each failure is logged with the device id and counted.
   */
  sendToUser(
    userId: number,
    payload: PushPayload,
    options: SendOptions,
  ): Promise<SendReport>;
}

type Outcome = 'delivered' | 'pruned' | 'failed';

// The push service no longer knows the subscription: the browser dropped it,
// the user revoked permission, or it expired. It will never work again.
const GONE_STATUSES = new Set([404, 410]);
// A socket timeout per request, so one unresponsive push service cannot hold
// the test route (or a future reminder run) open.
const REQUEST_TIMEOUT_MS = 10_000;
const ERROR_BODY_LOG_LIMIT = 200;

/**
 * The one way to send a Web Push message (web-push, RFC 8291 aes128gcm, the
 * encoding every current browser accepts). The VAPID details are checked
 * here, at boot, so a malformed key or a non-https SITE_URL fails the start
 * rather than every send; they are passed per request, never set globally.
 *
 * Endpoints are capability URLs: logs name a device by its row id, never
 * by endpoint (a WebPushError carries the endpoint; it is not logged whole).
 */
export function createPushSender(options: {
  db: Db;
  logger: WebLogger;
  vapid: VapidConfig;
}): PushSender {
  const { db, logger, vapid } = options;
  webpush.getVapidHeaders(
    new URL(vapid.subject).origin,
    vapid.subject,
    vapid.publicKey,
    vapid.privateKey,
    'aes128gcm',
  );

  async function deliver(
    userId: number,
    device: DeviceRow,
    body: string,
    { ttlSeconds }: SendOptions,
  ): Promise<Outcome> {
    try {
      await webpush.sendNotification(
        {
          endpoint: device.pushEndpoint,
          keys: { p256dh: device.keyP256dh, auth: device.keyAuth },
        },
        body,
        {
          vapidDetails: vapid,
          TTL: ttlSeconds,
          contentEncoding: 'aes128gcm',
          timeout: REQUEST_TIMEOUT_MS,
        },
      );
      return 'delivered';
    } catch (error) {
      if (
        error instanceof webpush.WebPushError &&
        GONE_STATUSES.has(error.statusCode)
      ) {
        await deleteDeviceById(db, device.id);
        logger.log(
          `Push device ${device.id} of user ${userId} is gone (${error.statusCode}); removed`,
        );
        return 'pruned';
      }
      logger.warn(
        `Push to device ${device.id} of user ${userId} failed: ${describeFailure(error)}`,
      );
      return 'failed';
    }
  }

  return {
    async sendToUser(userId, payload, sendOptions) {
      const devices = await devicesOf(db, userId);
      const body = JSON.stringify(payload);
      const settled = await Promise.allSettled(
        devices.map((device) => deliver(userId, device, body, sendOptions)),
      );
      const report: SendReport = {
        devices: devices.length,
        delivered: 0,
        pruned: 0,
        failed: 0,
      };
      settled.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          report[result.value] += 1;
          return;
        }
        // Only the prune can get here (a database error deleting the row).
        report.failed += 1;
        logger.error(
          `Push to device ${devices[index].id} of user ${userId}: could not remove the gone device`,
          result.reason instanceof Error
            ? result.reason.stack
            : String(result.reason),
        );
      });
      logger.log(
        `Push "${payload.tag ?? payload.title}" to user ${userId}: ${report.delivered}/${report.devices} delivered, ${report.pruned} removed, ${report.failed} failed`,
      );
      return report;
    },
  };
}

// The status and the start of the push service's answer (FCM and Mozilla
// explain a refused VAPID token there); never the endpoint.
function describeFailure(error: unknown): string {
  if (error instanceof webpush.WebPushError) {
    const body = error.body.trim().slice(0, ERROR_BODY_LOG_LIMIT);
    return body
      ? `HTTP ${error.statusCode}: ${body}`
      : `HTTP ${error.statusCode}`;
  }
  return error instanceof Error ? error.message : String(error);
}
