import jwt from 'jsonwebtoken';

// sync.js talks to Postgres through getPool() (raw pg Pool/Client, not the
// Drizzle layer) so it can hold row locks inside its own short
// transactions. This fake implements just enough of the pg Pool/Client
// surface -- connect/query/release, BEGIN/COMMIT/ROLLBACK -- backed by an
// in-memory store, to exercise the actual route logic (idempotent replay,
// optimistic-concurrency conflict detection, per-user isolation) without a
// real database. Shared between sync.test.js (route-level tests) and
// sync.e2e.test.js (real desktop sync engine against real Express routes).
export function createFakePool() {
  const state = {
    devices: new Map(), // device_id -> { deviceId, userCode, revokedAt }
    analyses: [], // rows
    syncOperations: new Map(), // operation_id -> row
    nextId: 1,
    nextRevision: 1,
  };

  function findAnalysis(clientId, userCode) {
    return state.analyses.find((r) => r.client_id === clientId && r.user_code === userCode) || null;
  }

  function toRow(r) {
    return { ...r };
  }

  const fakeClient = {
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();

      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

      if (s.includes('SELECT 1 FROM devices WHERE device_id')) {
        const [deviceId, userCode] = params;
        const d = state.devices.get(deviceId);
        return { rows: d && d.userCode === userCode && !d.revokedAt ? [{ '?column?': 1 }] : [] };
      }

      if (s.includes('UPDATE devices SET last_seen_at')) {
        const [deviceId] = params;
        const d = state.devices.get(deviceId);
        if (d) d.lastSeenAt = new Date();
        return { rows: [] };
      }

      if (s.includes('SELECT device_id, revoked_at, last_seen_at FROM devices')) {
        const [deviceId, userCode] = params;
        const d = state.devices.get(deviceId);
        if (!d || d.userCode !== userCode) return { rows: [] };
        return { rows: [{ device_id: d.deviceId, revoked_at: d.revokedAt || null, last_seen_at: d.lastSeenAt || null }] };
      }

      if (s.includes('SELECT status, server_version, server_payload FROM sync_operations')) {
        const [operationId] = params;
        const op = state.syncOperations.get(operationId);
        return { rows: op ? [toRow(op)] : [] };
      }

      if (s.includes('FROM analyses WHERE client_id = $1 AND user_code = $2 FOR UPDATE')) {
        const [clientId, userCode] = params;
        const row = findAnalysis(clientId, userCode);
        return { rows: row ? [toRow(row)] : [] };
      }

      if (s.startsWith('INSERT INTO analyses')) {
        // item 5/6: INSERT now also carries data_classification as its 6th
        // column/param, shifting client_id/device_id to $7/$8 -- see
        // sync.js's applyOperation() create branch.
        const [userCode, category, title, content, aiProvider, dataClassification, clientId, deviceId] = params;
        const row = {
          id: state.nextId++,
          user_code: userCode,
          category,
          title,
          content,
          ai_provider: aiProvider,
          data_classification: dataClassification,
          fraud_transaction_count: null,
          fraud_flagged_count: null,
          created_at: new Date(),
          client_id: clientId,
          device_id: deviceId,
          version: 1,
          updated_at: new Date(),
          deleted_at: null,
          sync_revision: state.nextRevision++,
        };
        state.analyses.push(row);
        return { rows: [toRow(row)] };
      }

      if (s.startsWith('UPDATE analyses SET title')) {
        // item 5/6: this UPDATE now also sets data_classification as its
        // 5th param -- see sync.js's applyOperation() update branch.
        const [clientId, deviceId, title, content, dataClassification] = params;
        const row = state.analyses.find((r) => r.client_id === clientId);
        row.title = title ?? row.title;
        row.content = content ?? row.content;
        row.data_classification = dataClassification;
        row.device_id = deviceId;
        row.version += 1;
        row.updated_at = new Date();
        row.sync_revision = state.nextRevision++;
        return { rows: [toRow(row)] };
      }

      if (s.startsWith('UPDATE analyses SET deleted_at')) {
        const [clientId, deviceId] = params;
        const row = state.analyses.find((r) => r.client_id === clientId);
        row.deleted_at = new Date();
        row.device_id = deviceId;
        row.version += 1;
        row.updated_at = new Date();
        row.sync_revision = state.nextRevision++;
        return { rows: [toRow(row)] };
      }

      if (s.startsWith('INSERT INTO sync_operations')) {
        const [operationId, userCode, deviceId, entityType, entityClientId, op, status, serverVersion, serverPayload, error] = params;
        state.syncOperations.set(operationId, {
          operation_id: operationId, user_code: userCode, device_id: deviceId, entity_type: entityType,
          entity_client_id: entityClientId, op, status, server_version: serverVersion,
          server_payload: serverPayload ? JSON.parse(serverPayload) : null, error,
        });
        return { rows: [] };
      }

      if (s.includes('FROM analyses WHERE user_code = $1 AND sync_revision > $2')) {
        const [userCode, since, limit] = params;
        const rows = state.analyses
          .filter((r) => r.user_code === userCode && r.sync_revision > since)
          .sort((a, b) => a.sync_revision - b.sync_revision)
          .slice(0, limit);
        return { rows: rows.map(toRow) };
      }

      if (s.includes('COALESCE(MAX(sync_revision), 0) AS latest')) {
        const [userCode] = params;
        const rows = state.analyses.filter((r) => r.user_code === userCode);
        const latest = rows.length ? Math.max(...rows.map((r) => r.sync_revision)) : 0;
        return { rows: [{ latest }] };
      }

      throw new Error(`fake pool: unhandled query: ${s}`);
    },
    release() {},
  };

  return {
    _state: state,
    _registerDevice(deviceId, userCode) {
      state.devices.set(deviceId, { deviceId, userCode, revokedAt: null });
    },
    async connect() {
      return fakeClient;
    },
    async query(sql, params) {
      return fakeClient.query(sql, params);
    },
  };
}

export function signToken(userCode, secret, options = {}) {
  return jwt.sign({ userCode }, secret, { expiresIn: '1h', ...options });
}
