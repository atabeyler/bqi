import { dbAll, dbGet, dbTransaction } from './index.js';
import { encryptField, decryptField } from './fieldCrypto.js';

const now = () => new Date().toISOString();

const rowToRecord = async (row) => ({
  id: row.id,
  userId: row.user_id,
  organizationId: row.organization_id,
  deviceId: row.device_id,
  type: row.type,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
  syncStatus: row.sync_status,
  category: row.category,
  title: await decryptField(row.title),
  content: await decryptField(row.content),
  aiProvider: row.ai_provider,
  fraudTransactionCount: row.fraud_transaction_count,
  fraudFlaggedCount: row.fraud_flagged_count,
});

function enqueueStatement({ entityType, entityId, op, payload, baseVersion, deviceId }) {
  return {
    statement: `
      INSERT INTO sync_queue (id, entity_type, entity_id, op, payload, base_version, device_id, status, created_at, next_attempt_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `,
    values: [
      crypto.randomUUID(), entityType, entityId, op,
      payload ? JSON.stringify(payload) : null, baseVersion ?? null, deviceId, now(), now(),
    ],
  };
}

// ── List / read (never returns tombstoned rows) ────────────────────────────
export async function listAnalyses(db, userId) {
  const rows = await dbAll(db, `SELECT * FROM analyses WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC`, [userId]);
  return Promise.all(rows.map(rowToRecord));
}

export async function getAnalysis(db, userId, id) {
  const row = await dbGet(db, `SELECT * FROM analyses WHERE id = ? AND user_id = ? AND deleted_at IS NULL`, [id, userId]);
  return row ? rowToRecord(row) : null;
}

// ── Create (offline-first: the row exists locally the instant this returns,
// synced or not) ────────────────────────────────────────────────────────────
export async function createAnalysis(db, { userId, deviceId, category, title, content, aiProvider }) {
  const id = crypto.randomUUID();
  const ts = now();
  const encryptedTitle = await encryptField(title);
  const encryptedContent = await encryptField(content);

  await dbTransaction(db, [
    {
      statement: `
        INSERT INTO analyses (id, user_id, organization_id, device_id, type, version, created_at, updated_at, sync_status, category, title, content, ai_provider)
        VALUES (?, ?, NULL, ?, 'analysis', 1, ?, ?, 'pending', ?, ?, ?, ?)
      `,
      values: [id, userId, deviceId, ts, ts, category, encryptedTitle, encryptedContent, aiProvider || null],
    },
    // A fresh create always lands at server version 1 (routes/sync.js's
    // create path is deterministic on that), so no baseVersion is needed.
    enqueueStatement({
      entityType: 'analysis', entityId: id, op: 'create',
      payload: { category, title: encryptedTitle, content: encryptedContent, aiProvider: aiProvider || null },
      deviceId,
    }),
  ]);

  return getAnalysis(db, userId, id);
}

// ── Update (optimistic local bump; queued op carries the *pre-edit* version
// as baseVersion so the server can detect a stale write) ───────────────────
export async function updateAnalysis(db, { userId, deviceId, id, title, content }) {
  const current = await dbGet(db, `SELECT * FROM analyses WHERE id = ? AND user_id = ? AND deleted_at IS NULL`, [id, userId]);
  if (!current) return null;

  const ts = now();
  const previousVersion = current.version;
  const encryptedTitle = title === undefined ? null : await encryptField(title);
  const encryptedContent = content === undefined ? null : await encryptField(content);

  await dbTransaction(db, [
    {
      statement: `
        UPDATE analyses SET
          title = COALESCE(?, title),
          content = COALESCE(?, content),
          version = version + 1,
          updated_at = ?,
          sync_status = 'pending'
        WHERE id = ?
      `,
      values: [encryptedTitle, encryptedContent, ts, id],
    },
    enqueueStatement({
      entityType: 'analysis', entityId: id, op: 'update',
      payload: { title: encryptedTitle, content: encryptedContent },
      baseVersion: previousVersion,
      deviceId,
    }),
  ]);

  return getAnalysis(db, userId, id);
}

// ── Soft delete (tombstone, mirrors the server's deleted_at column) ────────
export async function deleteAnalysis(db, { userId, deviceId, id }) {
  const current = await dbGet(db, `SELECT * FROM analyses WHERE id = ? AND user_id = ? AND deleted_at IS NULL`, [id, userId]);
  if (!current) return false;

  const ts = now();
  const previousVersion = current.version;

  await dbTransaction(db, [
    {
      statement: `UPDATE analyses SET deleted_at = ?, version = version + 1, updated_at = ?, sync_status = 'pending' WHERE id = ?`,
      values: [ts, ts, id],
    },
    enqueueStatement({
      entityType: 'analysis', entityId: id, op: 'delete',
      baseVersion: previousVersion,
      deviceId,
    }),
  ]);

  return true;
}

export const _internal = { rowToRecord, enqueueStatement };
