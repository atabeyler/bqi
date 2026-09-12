import { query } from '../db/client.js';
import { recordAuditEvent } from './audit.js';

export async function createRemediation({ orgId, actorUserId, findingId, recommendation, assigneeUserId }) {
  const { rows } = await query(
    `INSERT INTO remediations (org_id, finding_id, assignee_user_id, recommendation, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [orgId, findingId, assigneeUserId ?? null, recommendation, actorUserId]
  );

  if (assigneeUserId) {
    await query("UPDATE findings SET status = 'ASSIGNED', updated_at = now() WHERE id = $1 AND status = 'NEW'", [findingId]);
  }

  await recordAuditEvent({
    orgId, actorUserId, action: 'remediation.create', targetType: 'remediation', targetId: rows[0].id, result: 'SUCCESS',
  });
  return rows[0];
}

export async function listRemediationsForFinding(orgId, findingId) {
  const { rows } = await query(
    'SELECT * FROM remediations WHERE org_id = $1 AND finding_id = $2 ORDER BY created_at DESC',
    [orgId, findingId]
  );
  return rows;
}

export async function updateRemediationStatus({ orgId, actorUserId, remediationId, status }) {
  const { rows } = await query(
    `UPDATE remediations SET status = $1, updated_at = now() WHERE id = $2 AND org_id = $3 RETURNING *`,
    [status, remediationId, orgId]
  );
  if (rows.length === 0) return null;

  if (status === 'IN_PROGRESS') {
    await query("UPDATE findings SET status = 'IN_REMEDIATION', updated_at = now() WHERE id = $1", [rows[0].finding_id]);
  } else if (status === 'DONE') {
    await query("UPDATE findings SET status = 'READY_FOR_VERIFICATION', updated_at = now() WHERE id = $1", [rows[0].finding_id]);
  }

  await recordAuditEvent({
    orgId, actorUserId, action: 'remediation.status_change', targetType: 'remediation', targetId: remediationId, result: 'SUCCESS', metadata: { status },
  });
  return rows[0];
}
