import express from 'express';
import rateLimit from 'express-rate-limit';
import { authMiddleware } from '../middleware/auth.js';
import { getPool } from '../services/database.js';
import { logger } from '../lib/logger.js';
import { classifyData, maxLevel } from '../services/decisionIntelligence.js';

const router = express.Router();

// Sync calls happen far more often than a normal user action (every queued
// offline write, on every reconnect), but each one is cheap and scoped to a
// single authenticated user -- generous but still bounded so a runaway
// desktop retry loop can't hammer the DB.
const syncLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Çok fazla senkronizasyon isteği — lütfen bir dakika sonra tekrar deneyin.' },
});

router.use(authMiddleware, syncLimiter);

const SUPPORTED_ENTITY_TYPES = new Set(['analysis']);
const MAX_OPERATIONS_PER_PUSH = 100;
const DEFAULT_PULL_LIMIT = 200;
const MAX_PULL_LIMIT = 500;

const analysisRowToPayload = (row) => ({
  category: row.category,
  title: row.title,
  content: row.content,
  aiProvider: row.ai_provider,
  dataClassification: row.data_classification,
  fraudTransactionCount: row.fraud_transaction_count,
  fraudFlaggedCount: row.fraud_flagged_count,
});

const toClientRecord = (row) => ({
  entityType: 'analysis',
  entityId: row.client_id,
  version: row.version,
  deviceId: row.device_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deleted: !!row.deleted_at,
  syncRevision: Number(row.sync_revision),
  payload: row.deleted_at ? null : analysisRowToPayload(row),
});

async function assertDeviceAuthorized(client, userCode, deviceId) {
  if (!deviceId || typeof deviceId !== 'string') {
    const err = new Error('deviceId gerekli');
    err.status = 400;
    throw err;
  }
  const { rows } = await client.query(
    `SELECT 1 FROM devices WHERE device_id = $1 AND user_code = $2 AND revoked_at IS NULL`,
    [deviceId, userCode]
  );
  if (!rows.length) {
    const err = new Error('Cihaz bu hesap için yetkili değil');
    err.status = 403;
    throw err;
  }
  await client.query(`UPDATE devices SET last_seen_at = NOW() WHERE device_id = $1`, [deviceId]);
}

// Applies a single queued operation inside its own short transaction so one
// bad/conflicting op in a batch never rolls back the others that already
// succeeded. Idempotent by operationId: a retried push with the same id
// returns the originally-recorded result instead of re-applying.
async function applyOperation(pool, userCode, deviceId, op) {
  const { operationId, entityType, op: kind, entityId, payload, baseVersion } = op;

  if (typeof operationId !== 'string' || !operationId) {
    return { operationId, status: 'error', error: 'operationId gerekli' };
  }
  if (!SUPPORTED_ENTITY_TYPES.has(entityType)) {
    return { operationId, status: 'error', error: 'Desteklenmeyen kayıt türü' };
  }
  if (typeof entityId !== 'string' || !entityId) {
    return { operationId, status: 'error', error: 'entityId gerekli' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: existingOps } = await client.query(
      `SELECT status, server_version, server_payload FROM sync_operations WHERE operation_id = $1`,
      [operationId]
    );
    if (existingOps.length) {
      await client.query('COMMIT');
      const prior = existingOps[0];
      return {
        operationId,
        status: prior.status,
        entityId,
        serverVersion: prior.server_version,
        serverPayload: prior.server_payload,
        replayed: true,
      };
    }

    const { rows: currentRows } = await client.query(
      `SELECT * FROM analyses WHERE client_id = $1 AND user_code = $2 FOR UPDATE`,
      [entityId, userCode]
    );
    const current = currentRows[0] || null;

    let result;
    if (kind === 'create') {
      if (current) {
        // Replayed create (e.g. app crashed after commit but before the
        // client saw the response) -- report the existing row rather than
        // inserting a duplicate.
        result = { status: 'applied', serverVersion: current.version, serverPayload: analysisRowToPayload(current) };
      } else {
        // classifyData() re-derives the category floor and only lets the
        // incoming payload's dataClassification RAISE above it, never
        // lower it -- a compromised/malicious sync source can't push a
        // downgraded classification onto a locally-created record.
        const insertClassification = classifyData(payload?.category, payload?.dataClassification);
        const { rows: inserted } = await client.query(
          `INSERT INTO analyses
             (user_code, category, title, content, ai_provider, data_classification, client_id, device_id, version, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, NOW())
           RETURNING *`,
          [userCode, payload?.category, payload?.title, payload?.content, payload?.aiProvider || null, insertClassification, entityId, deviceId]
        );
        const row = inserted[0];
        result = { status: 'applied', serverVersion: row.version, serverPayload: analysisRowToPayload(row) };
      }
    } else if (kind === 'update') {
      if (!current) {
        result = { status: 'error', error: 'not_found' };
      } else if (current.version !== baseVersion) {
        result = {
          status: 'conflict',
          serverVersion: current.version,
          serverPayload: current.deleted_at ? null : analysisRowToPayload(current),
          deleted: !!current.deleted_at,
        };
      } else {
        // Same never-downgrade rule as create above, applied against the
        // row's CURRENT stored classification rather than only the
        // category floor -- an update payload can raise it further (e.g.
        // a client later marking an existing report RESTRICTED) but can
        // never lower what's already been set.
        const incomingUpper = payload?.dataClassification ? String(payload.dataClassification).toUpperCase() : null;
        const updateClassification = incomingUpper
          ? maxLevel(current.data_classification || classifyData(current.category), incomingUpper)
          : current.data_classification;
        const { rows: updated } = await client.query(
          `UPDATE analyses
             SET title = COALESCE($3, title),
                 content = COALESCE($4, content),
                 data_classification = $5,
                 device_id = $2,
                 version = version + 1,
                 updated_at = NOW(),
                 sync_revision = nextval('analyses_sync_revision_seq')
           WHERE client_id = $1
           RETURNING *`,
          [entityId, deviceId, payload?.title ?? null, payload?.content ?? null, updateClassification]
        );
        const row = updated[0];
        result = { status: 'applied', serverVersion: row.version, serverPayload: analysisRowToPayload(row) };
      }
    } else if (kind === 'delete') {
      if (!current || current.deleted_at) {
        // Desired end state (gone) already holds -- idempotent success.
        result = { status: 'applied', serverVersion: current ? current.version : null, serverPayload: null };
      } else if (current.version !== baseVersion) {
        result = { status: 'conflict', serverVersion: current.version, serverPayload: analysisRowToPayload(current), deleted: false };
      } else {
        const { rows: deleted } = await client.query(
          `UPDATE analyses
             SET deleted_at = NOW(),
                 device_id = $2,
                 version = version + 1,
                 updated_at = NOW(),
                 sync_revision = nextval('analyses_sync_revision_seq')
           WHERE client_id = $1
           RETURNING *`,
          [entityId, deviceId]
        );
        const row = deleted[0];
        result = { status: 'applied', serverVersion: row.version, serverPayload: null };
      }
    } else {
      result = { status: 'error', error: 'Desteklenmeyen işlem türü' };
    }

    await client.query(
      `INSERT INTO sync_operations
         (operation_id, user_code, device_id, entity_type, entity_client_id, op, status, server_version, server_payload, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
      [
        operationId, userCode, deviceId, entityType, entityId, kind,
        result.status, result.serverVersion ?? null,
        result.serverPayload ? JSON.stringify(result.serverPayload) : null,
        result.error || null,
      ]
    );

    await client.query('COMMIT');
    return { operationId, entityId, ...result };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err, operationId }, '[Sync] operation failed');
    return { operationId, entityId, status: 'error', error: 'Sunucu hatası' };
  } finally {
    client.release();
  }
}

// ── Push a batch of queued offline operations ─────────────────────────────
router.post('/push', async (req, res) => {
  try {
    const { userCode } = req.user;
    const { deviceId, operations } = req.body || {};
    const pool = getPool();
    const client = await pool.connect();
    try {
      await assertDeviceAuthorized(client, userCode, deviceId);
    } finally {
      client.release();
    }

    if (!Array.isArray(operations) || !operations.length) {
      return res.status(400).json({ error: 'operations dizisi gerekli' });
    }
    if (operations.length > MAX_OPERATIONS_PER_PUSH) {
      return res.status(400).json({ error: `Bir seferde en fazla ${MAX_OPERATIONS_PER_PUSH} işlem gönderilebilir` });
    }

    const results = [];
    // Sequential, not parallel: operations from the same device are
    // expected to be applied in the order the client queued them (e.g. a
    // create must land before a later update to the same entityId).
    for (const op of operations) {
      results.push(await applyOperation(pool, userCode, deviceId, op));
    }

    res.json({ results });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    logger.error({ err }, '[Sync] push failed');
    res.status(500).json({ error: err.message });
  }
});

// ── Pull records changed since a cursor ────────────────────────────────────
router.get('/pull', async (req, res) => {
  try {
    const { userCode } = req.user;
    const deviceId = req.query.deviceId;
    const since = Number(req.query.since) || 0;
    const limit = Math.min(Number(req.query.limit) || DEFAULT_PULL_LIMIT, MAX_PULL_LIMIT);
    const pool = getPool();

    const client = await pool.connect();
    try {
      await assertDeviceAuthorized(client, userCode, deviceId);
    } finally {
      client.release();
    }

    const { rows } = await pool.query(
      `SELECT * FROM analyses WHERE user_code = $1 AND sync_revision > $2 ORDER BY sync_revision ASC LIMIT $3`,
      [userCode, since, limit]
    );

    const records = rows.map(toClientRecord);
    const nextCursor = records.length ? records[records.length - 1].syncRevision : since;
    res.json({ records, nextCursor, hasMore: rows.length === limit });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    logger.error({ err }, '[Sync] pull failed');
    res.status(500).json({ error: err.message });
  }
});

// ── Informational: device authorization + latest server-side cursor ───────
router.get('/status', async (req, res) => {
  try {
    const { userCode } = req.user;
    const deviceId = req.query.deviceId;
    const pool = getPool();

    const { rows: deviceRows } = await pool.query(
      `SELECT device_id, revoked_at, last_seen_at FROM devices WHERE device_id = $1 AND user_code = $2`,
      [deviceId, userCode]
    );
    const { rows: revisionRows } = await pool.query(
      `SELECT COALESCE(MAX(sync_revision), 0) AS latest FROM analyses WHERE user_code = $1`,
      [userCode]
    );

    const device = deviceRows[0];
    res.json({
      deviceAuthorized: !!device && !device.revoked_at,
      lastSeenAt: device?.last_seen_at || null,
      latestServerRevision: Number(revisionRows[0].latest),
    });
  } catch (err) {
    logger.error({ err }, '[Sync] status failed');
    res.status(500).json({ error: err.message });
  }
});

export default router;
