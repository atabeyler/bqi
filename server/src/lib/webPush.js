/**
 * Web Push for emergency notifications -- a closed browser tab still means a
 * missed alert via the in-app toast/socket notification alone, so this adds
 * a second, OS-level delivery path via the Push API. Requires VAPID_PUBLIC_KEY
 * / VAPID_PRIVATE_KEY (generate with `npx web-push generate-vapid-keys`) --
 * without them, isPushConfigured() is false and sendPushToUsers() is a no-op.
 */
import webpush from 'web-push';
import { getDb, isDbConfigured } from '../db/client.js';
import { pushSubscriptions } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { logger } from './logger.js';

let configured = false;

export function isPushConfigured() {
  if (configured) return true;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:info@boldkimya.com.tr', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
  return true;
}

export function getVapidPublicKey() {
  return isPushConfigured() ? process.env.VAPID_PUBLIC_KEY : null;
}

export async function saveSubscription(userCode, subscription) {
  if (!isDbConfigured()) return;
  const { endpoint, keys } = subscription || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) return;
  await getDb()
    .insert(pushSubscriptions)
    .values({ userCode, endpoint, p256dh: keys.p256dh, auth: keys.auth })
    .onConflictDoNothing({ target: pushSubscriptions.endpoint });
}

export async function removeSubscription(endpoint) {
  if (!isDbConfigured() || !endpoint) return;
  await getDb().delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
}

/**
 * Sends a push notification to every subscription on file (optionally
 * scoped to a single user's own subscriptions). Expired/invalid
 * subscriptions (HTTP 404/410 from the push service) are pruned as they're
 * discovered instead of retried forever.
 */
export async function sendPushToUsers(payload, userCode = null) {
  if (!isPushConfigured() || !isDbConfigured()) return;
  try {
    const rows = userCode
      ? await getDb().select().from(pushSubscriptions).where(eq(pushSubscriptions.userCode, userCode))
      : await getDb().select().from(pushSubscriptions);

    const body = JSON.stringify(payload);
    await Promise.all(rows.map(async (row) => {
      try {
        await webpush.sendNotification(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          body
        );
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await removeSubscription(row.endpoint).catch(() => {});
        } else {
          logger.warn({ err: err.message }, '[WebPush] Send failed');
        }
      }
    }));
  } catch (err) {
    logger.warn({ err }, '[WebPush] sendPushToUsers error');
  }
}
