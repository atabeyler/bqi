import express from 'express';
import { sendEmergencyAlert, sendEmergencyBroadcastEmail } from '../services/email.js';
import { getDb, isDbConfigured } from '../db/client.js';
import { getUserEmailRecipients } from '../services/database.js';
import { emergencyLogs } from '../db/schema.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole, ROLES } from '../lib/rbac.js';
import { getOptionalUserCode } from '../lib/optionalAuth.js';
import { publicActionLimiter } from '../middleware/rateLimit.js';
import { logger } from '../lib/logger.js';
import { getVapidPublicKey, saveSubscription, removeSubscription, sendPushToUsers } from '../lib/webPush.js';

const router = express.Router();

// Web Push subscription management -- lets a closed/backgrounded browser tab
// still receive an emergency broadcast as an OS-level notification, not just
// the in-app socket toast (see lib/webPush.js).
router.get('/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: getVapidPublicKey() });
});

router.post('/push/subscribe', authMiddleware, async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ error: 'Geçersiz push aboneliği' });
    }
    await saveSubscription(req.user.userCode, subscription);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/push/unsubscribe', authMiddleware, async (req, res) => {
  try {
    const { endpoint } = req.body;
    await removeSubscription(endpoint);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const MAX_MESSAGE_LENGTH = 2000;
const MAX_REGION_LENGTH = 100;

function validMessage(message) {
  return typeof message === 'string' && message.trim().length > 0 && message.length <= MAX_MESSAGE_LENGTH;
}

function validRegion(region) {
  return region === undefined || region === null || (typeof region === 'string' && region.length <= MAX_REGION_LENGTH);
}

// Emergency notification accessible without authentication (pre-login center button)
router.post('/center', publicActionLimiter, async (req, res) => {
  try {
    const { message, region } = req.body;
    if (!validMessage(message)) return res.status(400).json({ error: 'Geçerli bir mesaj gerekli (en fazla 2000 karakter)' });
    if (!validRegion(region)) return res.status(400).json({ error: 'Bölge adı çok uzun' });

    const userCode = getOptionalUserCode(req);

    if (isDbConfigured()) {
      await getDb().insert(emergencyLogs).values({ userCode, message, target: 'center', region: region || null });
    }

    await sendEmergencyAlert(userCode, message, region);
    res.json({ success: true, message: 'Acil bildirim merkeze iletildi.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Emergency broadcast to every other logged-in user's live session -- unlike
// /center and /region (which only ever reach the center mailbox), this reaches
// every connected client's screen in real time (socket + email + push to the
// entire user base), so a valid login alone isn't enough gate: it requires
// ADMIN role (rbac.js's generic tier stands in for a real "Duty Officer/
// Crisis Commander" role until one exists -- see that file's own comment).
router.post('/users', authMiddleware, requireRole(ROLES.ADMIN), publicActionLimiter, async (req, res) => {
  try {
    const { message } = req.body;
    if (!validMessage(message)) return res.status(400).json({ error: 'Geçerli bir mesaj gerekli (en fazla 2000 karakter)' });

    const userCode = req.user.userCode;

    if (isDbConfigured()) {
      await getDb().insert(emergencyLogs).values({ userCode, message, target: 'users' });
    }

    const io = req.app.get('io');
    if (io) {
      io.emit('emergency:broadcast', {
        from: userCode,
        message,
        timestamp: Date.now()
      });
    }

    // Also email every registered user with an address on file, active or
    // not -- socket broadcast alone only reaches whoever happens to be
    // connected right now, and an inactive user has no other way to see it.
    getUserEmailRecipients()
      .then((recipients) => recipients.length && sendEmergencyBroadcastEmail(userCode, message, recipients))
      .catch((err) => logger.warn({ err }, '[Emergency] Broadcast email failed'));

    // Web Push -- reaches subscribed users even with the app tab closed or
    // backgrounded, unlike the socket broadcast above (only live sockets).
    sendPushToUsers({ title: 'BQI — Acil Yayın', body: `${userCode}: ${message}`, tag: 'emergency' })
      .catch((err) => logger.warn({ err }, '[Emergency] Push broadcast failed'));

    res.json({ success: true, message: 'Tüm kullanıcılara iletildi.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Regional emergency notification from a map pin
router.post('/region', publicActionLimiter, async (req, res) => {
  try {
    const { region, message } = req.body;
    if (!validMessage(message)) return res.status(400).json({ error: 'Geçerli bir mesaj gerekli (en fazla 2000 karakter)' });
    if (!validRegion(region)) return res.status(400).json({ error: 'Bölge adı çok uzun' });

    const userCode = getOptionalUserCode(req);

    if (isDbConfigured()) {
      await getDb().insert(emergencyLogs).values({ userCode, message, target: 'region', region });
    }

    await sendEmergencyAlert(userCode, message, region);
    res.json({ success: true, message: `${region} bölgesi için merkeze bildirim gönderildi.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
