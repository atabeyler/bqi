import express from 'express';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { authMiddleware } from '../middleware/auth.js';
import { publicActionLimiter } from '../middleware/rateLimit.js';
import { getDb, isDbConfigured } from '../db/client.js';
import { devices } from '../db/schema.js';
import { logger } from '../lib/logger.js';

const router = express.Router();

// Desktop device_ids look like BQI-WIN-XXXXXXXX (see desktop/auth/deviceId.js)
// but this is intentionally loose so other future platforms (BQI-MAC-...,
// BQI-LINUX-...) aren't rejected here.
const DEVICE_ID_RE = /^[A-Z0-9-]{6,64}$/i;

const toDeviceJson = (row) => ({
  device_id: row.deviceId,
  device_name: row.deviceName,
  platform: row.platform,
  app_version: row.appVersion,
  authorized_at: row.authorizedAt,
  last_seen_at: row.lastSeenAt,
  revoked: !!row.revokedAt,
});

// ── Register (or re-authorize) this device for the current account ───────
// Requires a *fresh, online* JWT -- this is the "online authorization" step
// that later lets the desktop app allow offline login for this device_id
// only (see desktop/auth/session.js).
router.post('/register', authMiddleware, publicActionLimiter, async (req, res) => {
  try {
    const { userCode } = req.user;
    const { deviceId, deviceName, platform, appVersion } = req.body || {};

    if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) {
      return res.status(400).json({ error: 'Geçersiz cihaz kimliği' });
    }
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'Veritabanı yapılandırılmamış' });
    }

    const db = getDb();
    const [existing] = await db.select().from(devices).where(eq(devices.deviceId, deviceId));

    let row;
    if (existing) {
      // Re-authorizing (possibly a different account on a shared machine, or
      // the same account logging in again) -- always allowed while online,
      // clears any prior revocation.
      [row] = await db
        .update(devices)
        .set({
          userCode,
          deviceName: deviceName || existing.deviceName,
          platform: platform || existing.platform,
          appVersion: appVersion || existing.appVersion,
          lastSeenAt: new Date(),
          authorizedAt: new Date(),
          revokedAt: null,
        })
        .where(eq(devices.deviceId, deviceId))
        .returning();
    } else {
      [row] = await db
        .insert(devices)
        .values({ deviceId, userCode, deviceName, platform, appVersion })
        .returning();
    }

    logger.info({ userCode, deviceId }, '[Devices] Device authorized');
    res.json({ success: true, device: toDeviceJson(row) });
  } catch (err) {
    logger.error({ err }, '[Devices] register failed');
    res.status(500).json({ error: err.message });
  }
});

// ── List this account's devices ───────────────────────────────────────────
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { userCode } = req.user;
    if (!isDbConfigured()) return res.json([]);

    const rows = await getDb()
      .select()
      .from(devices)
      .where(eq(devices.userCode, userCode))
      .orderBy(desc(devices.lastSeenAt));
    res.json(rows.map(toDeviceJson));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Revoke a device (e.g. lost/stolen laptop) ─────────────────────────────
// Scoped to the caller's own user_code -- a user can never revoke (or even
// see) another user's devices.
router.delete('/:deviceId', authMiddleware, async (req, res) => {
  try {
    const { userCode } = req.user;
    if (!isDbConfigured()) return res.json({ success: true });

    await getDb()
      .update(devices)
      .set({ revokedAt: new Date() })
      .where(and(eq(devices.deviceId, req.params.deviceId), eq(devices.userCode, userCode), isNull(devices.revokedAt)));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
