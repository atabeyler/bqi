import { dbGet, dbRun } from '../db/index.js';
import { encryptField, decryptField } from '../db/fieldCrypto.js';

// Registry of per-entity-type local persistence for sync/engine.js's
// pushQueue/pullChanges. Those two functions (queueing, backoff, conflict
// detection, cursor paging) are already entity-agnostic; only "how does
// a pushed/pulled record for THIS entity type get written to the local
// SQLite schema" is entity-specific. Today only 'analysis' is wired up
// end-to-end (matching the server, which only accepts 'analysis' in
// server/src/routes/sync.js's SUPPORTED_ENTITY_TYPES and this project's
// desktop counterpart, desktop/sync/entityHandlers.js) -- adding a future
// entity means adding one handler here plus its own local table/migration,
// not touching pushQueue/pullChanges again.
const handlers = {
  analysis: {
    async applyApplied(db, op, result) {
      const ts = new Date().toISOString();
      await dbRun(db, `UPDATE analyses SET version = ?, sync_status = 'synced', updated_at = ? WHERE id = ?`, [result.serverVersion, ts, op.entity_id]);
    },

    async preparePushPayload(payload) {
      if (!payload) return payload;
      return {
        ...payload,
        title: await decryptField(payload.title ?? null),
        content: await decryptField(payload.content ?? null),
      };
    },

    // Builds the statement for one pulled record (or null to skip it) --
    // the caller batches every record in a page into one atomic
    // transaction, so this only prepares, it never executes.
    async buildPulledStatement(db, userId, record) {
      const ts = new Date().toISOString();
      const existing = await dbGet(db, `SELECT id FROM analyses WHERE id = ?`, [record.entityId]);

      if (record.deleted) {
        if (!existing) return null;
        return {
          statement: `UPDATE analyses SET deleted_at = ?, version = ?, updated_at = ?, sync_status = 'synced' WHERE id = ?`,
          values: [ts, record.version, ts, record.entityId],
        };
      }

      if (existing) {
        return {
          statement: `
            UPDATE analyses SET title = ?, content = ?, category = ?, ai_provider = ?,
              fraud_transaction_count = ?, fraud_flagged_count = ?,
              version = ?, updated_at = ?, deleted_at = NULL, sync_status = 'synced', device_id = ?
            WHERE id = ?
          `,
          values: [
            await encryptField(record.payload.title), await encryptField(record.payload.content), record.payload.category, record.payload.aiProvider ?? null,
            record.payload.fraudTransactionCount ?? null, record.payload.fraudFlaggedCount ?? null,
            record.version, ts, record.deviceId, record.entityId,
          ],
        };
      }

      return {
        statement: `
          INSERT INTO analyses (id, user_id, organization_id, device_id, type, version, created_at, updated_at, sync_status, category, title, content, ai_provider, fraud_transaction_count, fraud_flagged_count)
          VALUES (?, ?, NULL, ?, 'analysis', ?, ?, ?, 'synced', ?, ?, ?, ?, ?, ?)
        `,
        values: [
          record.entityId, userId, record.deviceId, record.version, record.createdAt, record.updatedAt,
          record.payload.category, await encryptField(record.payload.title), await encryptField(record.payload.content), record.payload.aiProvider ?? null,
          record.payload.fraudTransactionCount ?? null, record.payload.fraudFlaggedCount ?? null,
        ],
      };
    },
  },
};

export function getEntityHandler(entityType) {
  const handler = handlers[entityType];
  if (!handler) throw new Error(`No sync handler registered for entity type: ${entityType}`);
  return handler;
}
