import { query } from '../db/client.js';

// Append-only by convention: this is the only function in the codebase that
// writes to audit_events, and no route exposes UPDATE/DELETE on it.
export async function recordAuditEvent({
  orgId = null,
  actorUserId = null,
  action,
  targetType = null,
  targetId = null,
  result,
  metadata = {},
}) {
  await query(
    `INSERT INTO audit_events (org_id, actor_user_id, action, target_type, target_id, result, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [orgId, actorUserId, action, targetType, targetId, result, JSON.stringify(metadata)]
  );
}
