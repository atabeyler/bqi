import { randomUUID } from 'node:crypto';
import { cancelQueuedFor } from './queue.js';
import { getEncryptionKey } from '../db/index.js';
import { encryptField, decryptField } from '../db/fieldCrypto.js';

const now = () => new Date().toISOString();

// The conflicts table persists both sides of the conflict to disk (BQI-002
// applies here too, same as the analyses table) -- title/content are
// encrypted going in and decrypted coming back out. localPayload (built
// from a sync_queue row) already carries ciphertext by the time it gets
// here (see analysesRepo.js), and encryptField() no-ops on an
// already-encrypted value, so encrypting defensively here is always safe.
// serverPayload arrives plaintext (the server has no concept of this
// device's key), so this is the point it gets encrypted for the first time.
function encryptPayload(payload) {
  if (!payload) return payload;
  const key = getEncryptionKey();
  return {
    ...payload,
    title: 'title' in payload ? encryptField(payload.title, key) : payload.title,
    content: 'content' in payload ? encryptField(payload.content, key) : payload.content,
  };
}

function decryptPayload(payload) {
  if (!payload) return payload;
  const key = getEncryptionKey();
  return {
    ...payload,
    title: 'title' in payload ? decryptField(payload.title, key) : payload.title,
    content: 'content' in payload ? decryptField(payload.content, key) : payload.content,
  };
}

// Records both sides of a conflict and stops the local record from being
// pushed again until the user (or an automated policy) resolves it — the
// server's copy is never silently overwritten, and neither is the user's
// local edit (spec: keep both versions and give the user a way to resolve).
export function recordConflict(db, { entityType, entityId, localPayload, localBaseVersion, serverPayload, serverVersion, serverDeleted }) {
  const record = db.transaction(() => {
    db.prepare(`
      INSERT INTO conflicts (id, entity_type, entity_id, local_payload, local_base_version, server_payload, server_version, server_deleted, detected_at)
      VALUES (@id, @entityType, @entityId, @localPayload, @localBaseVersion, @serverPayload, @serverVersion, @serverDeleted, @detectedAt)
    `).run({
      id: randomUUID(),
      entityType,
      entityId,
      localPayload: JSON.stringify(encryptPayload(localPayload)),
      localBaseVersion: localBaseVersion ?? null,
      serverPayload: serverPayload ? JSON.stringify(encryptPayload(serverPayload)) : null,
      serverVersion: serverVersion ?? null,
      serverDeleted: serverDeleted ? 1 : 0,
      detectedAt: now(),
    });

    db.prepare(`UPDATE analyses SET sync_status = 'conflict' WHERE id = ?`).run(entityId);
    cancelQueuedFor(db, entityType, entityId);
  });
  record();
}

export function listUnresolvedConflicts(db) {
  return db.prepare(`SELECT * FROM conflicts WHERE resolved_at IS NULL ORDER BY detected_at DESC`).all().map((row) => ({
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    localPayload: decryptPayload(JSON.parse(row.local_payload)),
    localBaseVersion: row.local_base_version,
    serverPayload: row.server_payload ? decryptPayload(JSON.parse(row.server_payload)) : null,
    serverVersion: row.server_version,
    serverDeleted: !!row.server_deleted,
    detectedAt: row.detected_at,
  }));
}

// resolution: 'kept_local' re-queues the local edit against the now-known
// server version; 'kept_server' overwrites the local row with the server's
// copy (or tombstones it if the server side was a delete).
export function resolveConflict(db, { conflictId, deviceId, resolution }) {
  const conflict = db.prepare(`SELECT * FROM conflicts WHERE id = ? AND resolved_at IS NULL`).get(conflictId);
  if (!conflict) return false;

  const ts = now();
  const resolve = db.transaction(() => {
    if (resolution === 'kept_server') {
      if (conflict.server_deleted) {
        db.prepare(`UPDATE analyses SET deleted_at = @ts, version = @version, updated_at = @ts, sync_status = 'synced' WHERE id = @id`)
          .run({ id: conflict.entity_id, ts, version: conflict.server_version });
      } else {
        const payload = JSON.parse(conflict.server_payload);
        db.prepare(`
          UPDATE analyses SET title = @title, content = @content, category = @category, ai_provider = @aiProvider,
            version = @version, updated_at = @ts, deleted_at = NULL, sync_status = 'synced'
          WHERE id = @id
        `).run({
          id: conflict.entity_id, ts, version: conflict.server_version,
          title: payload.title, content: payload.content, category: payload.category, aiProvider: payload.aiProvider ?? null,
        });
      }
    } else if (resolution === 'kept_local') {
      const localPayload = JSON.parse(conflict.local_payload);
      db.prepare(`UPDATE analyses SET version = @version, sync_status = 'pending', updated_at = @ts WHERE id = @id`)
        .run({ id: conflict.entity_id, ts, version: conflict.server_version });

      db.prepare(`
        INSERT INTO sync_queue (id, entity_type, entity_id, op, payload, base_version, device_id, status, created_at, next_attempt_at)
        VALUES (@id, @entityType, @entityId, 'update', @payload, @baseVersion, @deviceId, 'pending', @ts, @ts)
      `).run({
        id: randomUUID(), entityType: conflict.entity_type, entityId: conflict.entity_id,
        payload: JSON.stringify({ title: localPayload.title, content: localPayload.content }),
        baseVersion: conflict.server_version, deviceId, ts,
      });
    } else {
      throw new Error(`Unknown resolution: ${resolution}`);
    }

    db.prepare(`UPDATE conflicts SET resolved_at = @ts, resolution = @resolution WHERE id = @id`)
      .run({ id: conflictId, ts, resolution });
  });
  resolve();
  return true;
}
