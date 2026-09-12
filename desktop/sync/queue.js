const MAX_ATTEMPTS = 8;
// 5s, 10s, 20s, ... capped at 30 minutes — a queued op is never dropped, it
// just backs off further after each failed attempt (spec: retry + backoff,
// nothing silently disappears).
const BASE_DELAY_MS = 5000;
const MAX_DELAY_MS = 30 * 60 * 1000;

function backoffMs(attempts) {
  return Math.min(BASE_DELAY_MS * 2 ** attempts, MAX_DELAY_MS);
}

// Ops due now, oldest first, one per entity_id at most per call — if an
// earlier op for the same record is still pending/in_flight, a later op on
// that same record must wait for it (order matters: a create must land
// before a later update to the same entityId, an update must land before a
// later delete, etc.).
export function getDueOperations(db, limit = 50) {
  const rows = db.prepare(`
    SELECT * FROM sync_queue
    WHERE status = 'pending' AND next_attempt_at <= @now
    ORDER BY created_at ASC
  `).all({ now: new Date().toISOString() });

  const seenEntities = new Set();
  const due = [];
  for (const row of rows) {
    const key = `${row.entity_type}:${row.entity_id}`;
    if (seenEntities.has(key)) continue; // an earlier op for this entity already queued this batch
    seenEntities.add(key);
    due.push(row);
    if (due.length >= limit) break;
  }
  return due;
}

export function markInFlight(db, id) {
  db.prepare(`UPDATE sync_queue SET status = 'in_flight' WHERE id = ?`).run(id);
}

export function markDone(db, id) {
  db.prepare(`UPDATE sync_queue SET status = 'done' WHERE id = ?`).run(id);
}

// Requeues with exponential backoff, or gives up (status = 'failed', still
// on disk with its last_error for the user/UI to see) after MAX_ATTEMPTS —
// "give up" here never means "delete the local record" or "drop the write",
// only "stop auto-retrying"; a forced manual re-sync can still pick it up.
export function markFailed(db, id, errorMessage) {
  const row = db.prepare(`SELECT attempts FROM sync_queue WHERE id = ?`).get(id);
  const attempts = (row?.attempts ?? 0) + 1;
  const giveUp = attempts >= MAX_ATTEMPTS;
  const nextAttemptAt = new Date(Date.now() + backoffMs(attempts)).toISOString();

  db.prepare(`
    UPDATE sync_queue SET
      attempts = @attempts,
      last_error = @error,
      status = @status,
      next_attempt_at = @nextAttemptAt
    WHERE id = @id
  `).run({ id, attempts, error: String(errorMessage).slice(0, 2000), status: giveUp ? 'failed' : 'pending', nextAttemptAt });
}

export function hasPendingOrInFlight(db, entityType, entityId) {
  const row = db.prepare(`
    SELECT 1 FROM sync_queue WHERE entity_type = ? AND entity_id = ? AND status IN ('pending', 'in_flight') LIMIT 1
  `).get(entityType, entityId);
  return !!row;
}

// Cancels every queued op for one entity — used when a conflict is detected
// so a chain of local edits built on a now-invalid baseVersion doesn't keep
// retrying against a version the server will never accept again.
export function cancelQueuedFor(db, entityType, entityId) {
  db.prepare(`
    UPDATE sync_queue SET status = 'failed', last_error = 'superseded by conflict'
    WHERE entity_type = ? AND entity_id = ? AND status IN ('pending', 'in_flight')
  `).run(entityType, entityId);
}

export const _internal = { backoffMs, MAX_ATTEMPTS };
