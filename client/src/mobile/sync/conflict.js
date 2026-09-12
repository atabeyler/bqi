import { dbAll, dbGet, dbTransaction } from '../db/index.js';
import { encryptField, decryptField } from '../db/fieldCrypto.js';
import { cancelQueuedFor } from './queue.js';

const now = () => new Date().toISOString();

// Records both sides of a conflict and stops the local record from being
// pushed again until the user (or an automated policy) resolves it — the
// server's copy is never silently overwritten, and neither is the user's
// local edit (spec: keep both versions and give the user a way to resolve).
export async function recordConflict(db, { entityType, entityId, localPayload, localBaseVersion, serverPayload, serverVersion, serverDeleted }) {
  await dbTransaction(db, [
    {
      statement: `
        INSERT INTO conflicts (id, entity_type, entity_id, local_payload, local_base_version, server_payload, server_version, server_deleted, detected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      values: [
        crypto.randomUUID(), entityType, entityId, JSON.stringify(localPayload), localBaseVersion ?? null,
        serverPayload ? JSON.stringify(serverPayload) : null, serverVersion ?? null, serverDeleted ? 1 : 0, now(),
      ],
    },
    { statement: `UPDATE analyses SET sync_status = 'conflict' WHERE id = ?`, values: [entityId] },
  ]);
  await cancelQueuedFor(db, entityType, entityId);
}

export async function listUnresolvedConflicts(db) {
  const rows = await dbAll(db, `SELECT * FROM conflicts WHERE resolved_at IS NULL ORDER BY detected_at DESC`);
  return Promise.all(rows.map(async (row) => {
    const localPayload = JSON.parse(row.local_payload);
    const serverPayload = row.server_payload ? JSON.parse(row.server_payload) : null;
    return {
      id: row.id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      localPayload: {
        ...localPayload,
        title: await decryptField(localPayload.title ?? null),
        content: await decryptField(localPayload.content ?? null),
      },
      localBaseVersion: row.local_base_version,
      serverPayload: serverPayload
        ? {
            ...serverPayload,
            title: await decryptField(serverPayload.title ?? null),
            content: await decryptField(serverPayload.content ?? null),
          }
        : null,
      serverVersion: row.server_version,
      serverDeleted: !!row.server_deleted,
      detectedAt: row.detected_at,
    };
  }));
}

// resolution: 'kept_local' re-queues the local edit against the now-known
// server version; 'kept_server' overwrites the local row with the server's
// copy (or tombstones it if the server side was a delete).
export async function resolveConflict(db, { conflictId, deviceId, resolution }) {
  const conflict = await dbGet(db, `SELECT * FROM conflicts WHERE id = ? AND resolved_at IS NULL`, [conflictId]);
  if (!conflict) return false;

  const ts = now();
  const statements = [];

  if (resolution === 'kept_server') {
    if (conflict.server_deleted) {
      statements.push({
        statement: `UPDATE analyses SET deleted_at = ?, version = ?, updated_at = ?, sync_status = 'synced' WHERE id = ?`,
        values: [ts, conflict.server_version, ts, conflict.entity_id],
      });
    } else {
      const payload = JSON.parse(conflict.server_payload);
      const encryptedTitle = await encryptField(payload.title ?? '');
      const encryptedContent = await encryptField(payload.content ?? '');
      statements.push({
        statement: `
          UPDATE analyses SET title = ?, content = ?, category = ?, ai_provider = ?,
            version = ?, updated_at = ?, deleted_at = NULL, sync_status = 'synced'
          WHERE id = ?
        `,
        values: [encryptedTitle, encryptedContent, payload.category, payload.aiProvider ?? null, conflict.server_version, ts, conflict.entity_id],
      });
    }
  } else if (resolution === 'kept_local') {
    const localPayload = JSON.parse(conflict.local_payload);
    statements.push(
      {
        statement: `UPDATE analyses SET version = ?, sync_status = 'pending', updated_at = ? WHERE id = ?`,
        values: [conflict.server_version, ts, conflict.entity_id],
      },
      {
        statement: `
          INSERT INTO sync_queue (id, entity_type, entity_id, op, payload, base_version, device_id, status, created_at, next_attempt_at)
          VALUES (?, ?, ?, 'update', ?, ?, ?, 'pending', ?, ?)
        `,
        values: [
          crypto.randomUUID(), conflict.entity_type, conflict.entity_id,
          // All locally-editable fields, not just title/content -- a
          // 'kept_local' resolution used to drop category/aiProvider even
          // if the local edit also touched those, silently losing them.
          JSON.stringify({ title: localPayload.title, content: localPayload.content, category: localPayload.category, aiProvider: localPayload.aiProvider ?? null }),
          conflict.server_version, deviceId, ts, ts,
        ],
      }
    );
  } else {
    throw new Error(`Unknown resolution: ${resolution}`);
  }

  statements.push({
    statement: `UPDATE conflicts SET resolved_at = ?, resolution = ? WHERE id = ?`,
    values: [ts, resolution, conflictId],
  });

  await dbTransaction(db, statements);
  return true;
}
