import { dbGet, dbRun, dbTransaction } from '../db/index.js';
import { getDueOperations, markInFlight, markDone, markFailed, hasPendingOrInFlight } from './queue.js';
import { recordConflict } from './conflict.js';
import { getEntityHandler } from './entityHandlers.js';

const MAX_PUSH_PASSES = 20; // guards against an unexpected infinite loop, not a normal ceiling

async function applyAppliedResult(db, op, result) {
  await getEntityHandler(op.entity_type).applyApplied(db, op, result);
}

// Pushes every due queued operation to the server, resuming exactly where a
// prior attempt (even one interrupted by the app being closed) left off —
// getDueOperations() only ever reads what's still on disk with status
// 'pending'. Runs multiple passes because getDueOperations caps at one op
// per entity per pass (ops on the same record must apply in order).
export async function pushQueue(db, { apiBaseUrl, getToken, deviceId, fetchImpl = fetch }) {
  let pushed = 0;
  let conflicts = 0;
  let failed = 0;

  for (let pass = 0; pass < MAX_PUSH_PASSES; pass++) {
    const due = await getDueOperations(db);
    if (!due.length) break;

    for (const op of due) await markInFlight(db, op.id);

    const operations = await Promise.all(due.map(async (op) => {
      const parsedPayload = op.payload ? JSON.parse(op.payload) : undefined;
      const handler = getEntityHandler(op.entity_type);
      const payload = parsedPayload && handler.preparePushPayload
        ? await handler.preparePushPayload(parsedPayload)
        : parsedPayload;
      return {
        operationId: op.id,
        entityType: op.entity_type,
        op: op.op,
        entityId: op.entity_id,
        payload,
        baseVersion: op.base_version ?? undefined,
      };
    }));

    let response;
    try {
      const token = await getToken();
      const res = await fetchImpl(`${apiBaseUrl}/api/sync/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ deviceId, operations }),
      });
      if (!res.ok) throw new Error(`push HTTP ${res.status}`);
      response = await res.json();
    } catch (err) {
      // Network/server failure: every op in this pass goes back to
      // 'pending' with backoff — nothing is lost, the next sync attempt
      // (reconnect, timer, or app relaunch) picks the same queue back up.
      for (const op of due) await markFailed(db, op.id, err.message);
      return { pushed, conflicts, failed: failed + due.length, error: err.message };
    }

    for (const result of response.results) {
      const op = due.find((o) => o.id === result.operationId);
      if (!op) continue;

      if (result.status === 'applied') {
        await markDone(db, op.id);
        await applyAppliedResult(db, op, result);
        pushed++;
      } else if (result.status === 'conflict') {
        await recordConflict(db, {
          entityType: op.entity_type,
          entityId: op.entity_id,
          localPayload: op.payload ? JSON.parse(op.payload) : {},
          localBaseVersion: op.base_version,
          serverPayload: result.serverPayload,
          serverVersion: result.serverVersion,
          serverDeleted: result.deleted,
        });
        conflicts++;
      } else {
        await markFailed(db, op.id, result.error || 'Bilinmeyen sunucu hatası');
        failed++;
      }
    }
  }

  return { pushed, conflicts, failed };
}

// Builds the statement for one pulled record (or null to skip it), resolving
// any needed lookups first -- the whole page is then applied as a single
// atomic transaction by pullChanges below.
async function buildPulledRecordStatement(db, userId, record) {
  // A record with local edits still in flight is never overwritten here —
  // the next push for it will either succeed (and this record shows up
  // again on a later pull, now safe to apply) or surface as a conflict.
  if (await hasPendingOrInFlight(db, record.entityType, record.entityId)) return null;
  return getEntityHandler(record.entityType).buildPulledStatement(db, userId, record);
}

// Pulls everything new since the locally stored cursor, in cursor order,
// persisting the cursor after each page so an interrupted pull resumes
// instead of re-downloading from zero.
export async function pullChanges(db, { apiBaseUrl, getToken, deviceId, userId, fetchImpl = fetch }) {
  let cursor = Number((await dbGet(db, `SELECT value FROM sync_state WHERE key = 'pull_cursor'`))?.value || 0);
  let pulled = 0;
  let hasMore = true;

  while (hasMore) {
    const token = await getToken();
    const res = await fetchImpl(
      `${apiBaseUrl}/api/sync/pull?since=${cursor}&deviceId=${encodeURIComponent(deviceId)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error(`pull HTTP ${res.status}`);
    const data = await res.json();

    const statements = [];
    for (const record of data.records) {
      const statement = await buildPulledRecordStatement(db, userId, record);
      if (statement) statements.push(statement);
    }
    if (statements.length) await dbTransaction(db, statements);

    pulled += data.records.length;
    cursor = data.nextCursor;
    hasMore = data.hasMore;

    await dbRun(db, `
      INSERT INTO sync_state (key, value) VALUES ('pull_cursor', ?)
      ON CONFLICT(key) DO UPDATE SET value = ?
    `, [String(cursor), String(cursor)]);
  }

  return { pulled, cursor };
}

// Full sync pass: push local changes first (so a record this device just
// edited isn't immediately clobbered by its own stale pull), then pull.
// Never throws — a failed sync just means "try again later", not a crash
// (spec: connectivity loss must never kick the user out of the app).
export async function runSync(db, ctx) {
  try {
    const pushResult = await pushQueue(db, ctx);
    const pullResult = await pullChanges(db, ctx);
    return { ok: true, push: pushResult, pull: pullResult };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
