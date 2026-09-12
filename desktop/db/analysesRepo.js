import { randomUUID } from 'node:crypto';
import { getEncryptionKey } from './index.js';
import { encryptField, decryptField } from './fieldCrypto.js';

const now = () => new Date().toISOString();

// title/content are the actual report text (BQI-002) -- encrypted at rest
// with a key protected by Electron's safeStorage (see dbKey.js/
// fieldCrypto.js). getEncryptionKey() is read fresh on every call rather
// than captured once, since it's only set once openDatabase() has run.
const rowToRecord = (row) => {
  const key = getEncryptionKey();
  return {
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
    title: decryptField(row.title, key),
    content: decryptField(row.content, key),
    aiProvider: row.ai_provider,
    fraudTransactionCount: row.fraud_transaction_count,
    fraudFlaggedCount: row.fraud_flagged_count,
  };
};

function enqueue(db, { entityType, entityId, op, payload, baseVersion, deviceId }) {
  db.prepare(`
    INSERT INTO sync_queue (id, entity_type, entity_id, op, payload, base_version, device_id, status, created_at, next_attempt_at)
    VALUES (@id, @entityType, @entityId, @op, @payload, @baseVersion, @deviceId, 'pending', @now, @now)
  `).run({
    id: randomUUID(),
    entityType,
    entityId,
    op,
    payload: payload ? JSON.stringify(payload) : null,
    baseVersion: baseVersion ?? null,
    deviceId,
    now: now(),
  });
}

// ── List / read (never returns tombstoned rows) ────────────────────────────
export function listAnalyses(db, userId) {
  return db.prepare(`
    SELECT * FROM analyses WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC
  `).all(userId).map(rowToRecord);
}

export function getAnalysis(db, userId, id) {
  const row = db.prepare(`SELECT * FROM analyses WHERE id = ? AND user_id = ? AND deleted_at IS NULL`).get(id, userId);
  return row ? rowToRecord(row) : null;
}

// ── Create (offline-first: the row exists locally the instant this returns,
// synced or not) ────────────────────────────────────────────────────────────
export function createAnalysis(db, { userId, deviceId, category, title, content, aiProvider }) {
  const id = randomUUID();
  const ts = now();
  const key = getEncryptionKey();
  const create = db.transaction(() => {
    const encryptedTitle = encryptField(title, key);
    const encryptedContent = encryptField(content, key);
    db.prepare(`
      INSERT INTO analyses (id, user_id, organization_id, device_id, type, version, created_at, updated_at, sync_status, category, title, content, ai_provider)
      VALUES (@id, @userId, NULL, @deviceId, 'analysis', 1, @ts, @ts, 'pending', @category, @title, @content, @aiProvider)
    `).run({ id, userId, deviceId, ts, category, title: encryptedTitle, content: encryptedContent, aiProvider: aiProvider || null });

    // A fresh create always lands at server version 1 (routes/sync.js's
    // create path is deterministic on that), so no baseVersion is needed.
    // The queued payload carries the SAME ciphertext already written above
    // (BQI-002) -- never the plaintext locals -- so sync_queue is opaque at
    // rest too. The push path (sync/engine.js) decrypts it back to
    // plaintext right before the network call, the one place it's needed.
    enqueue(db, {
      entityType: 'analysis', entityId: id, op: 'create',
      payload: { category, title: encryptedTitle, content: encryptedContent, aiProvider: aiProvider || null },
      deviceId,
    });
  });
  create();
  return getAnalysis(db, userId, id);
}

// ── Update (optimistic local bump; queued op carries the *pre-edit* version
// as baseVersion so the server can detect a stale write) ───────────────────
export function updateAnalysis(db, { userId, deviceId, id, title, content }) {
  const current = db.prepare(`SELECT * FROM analyses WHERE id = ? AND user_id = ? AND deleted_at IS NULL`).get(id, userId);
  if (!current) return null;

  const ts = now();
  const previousVersion = current.version;
  const key = getEncryptionKey();
  const update = db.transaction(() => {
    const encryptedTitle = encryptField(title ?? null, key);
    const encryptedContent = encryptField(content ?? null, key);
    db.prepare(`
      UPDATE analyses SET
        title = COALESCE(@title, title),
        content = COALESCE(@content, content),
        version = version + 1,
        updated_at = @ts,
        sync_status = 'pending'
      WHERE id = @id
    `).run({ id, title: encryptedTitle, content: encryptedContent, ts });

    // Same as createAnalysis: the queued payload carries the already-
    // encrypted values, never the plaintext locals.
    enqueue(db, {
      entityType: 'analysis', entityId: id, op: 'update',
      payload: { title: encryptedTitle, content: encryptedContent },
      baseVersion: previousVersion,
      deviceId,
    });
  });
  update();
  return getAnalysis(db, userId, id);
}

// ── Soft delete (tombstone, mirrors the server's deleted_at column) ────────
export function deleteAnalysis(db, { userId, deviceId, id }) {
  const current = db.prepare(`SELECT * FROM analyses WHERE id = ? AND user_id = ? AND deleted_at IS NULL`).get(id, userId);
  if (!current) return false;

  const ts = now();
  const previousVersion = current.version;
  const del = db.transaction(() => {
    db.prepare(`
      UPDATE analyses SET deleted_at = @ts, version = version + 1, updated_at = @ts, sync_status = 'pending' WHERE id = @id
    `).run({ id, ts });

    enqueue(db, {
      entityType: 'analysis', entityId: id, op: 'delete',
      baseVersion: previousVersion,
      deviceId,
    });
  });
  del();
  return true;
}

export const _internal = { rowToRecord, enqueue };
