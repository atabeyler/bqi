import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/client.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../lib/rbac.js';
import { recordAuditEvent } from '../services/audit.js';
import { createRemediation, listRemediationsForFinding, updateRemediationStatus } from '../services/remediation.js';
import { verifyFix } from '../services/verify.js';
import { explainFinding } from '../services/decisionSupport.js';

export const findingsRouter = Router();

findingsRouter.use(requireAuth);

async function loadOwnedFinding(orgId, findingId) {
  const { rows } = await query('SELECT * FROM findings WHERE id = $1 AND org_id = $2', [findingId, orgId]);
  return rows[0] || null;
}

async function setStatus(req, res, findingId, nextStatus, verificationStatus) {
  const finding = await loadOwnedFinding(req.auth.orgId, findingId);
  if (!finding) return res.status(404).json({ error: 'finding_not_found', requestId: req.id });

  const { rows } = await query(
    `UPDATE findings SET status = $1, verification_status = COALESCE($2, verification_status), updated_at = now()
      WHERE id = $3 RETURNING *`,
    [nextStatus, verificationStatus ?? null, findingId]
  );

  await recordAuditEvent({
    orgId: req.auth.orgId,
    actorUserId: req.auth.userId,
    action: 'finding.status_change',
    targetType: 'finding',
    targetId: findingId,
    result: 'SUCCESS',
    metadata: { from: finding.status, to: nextStatus },
  });

  res.json({ finding: rows[0] });
}

findingsRouter.get('/', requirePermission('finding:view'), async (req, res) => {
  const { rows } = await query(
    `SELECT id, category, title, cve_ids, cwe_ids, component, component_version, location,
            target, status, verification_status, confidence_score, created_at, updated_at
       FROM findings WHERE org_id = $1 ORDER BY created_at DESC`,
    [req.auth.orgId]
  );
  res.json({ findings: rows });
});

findingsRouter.get('/:id', requirePermission('finding:view'), async (req, res) => {
  const finding = await loadOwnedFinding(req.auth.orgId, req.params.id);
  if (!finding) return res.status(404).json({ error: 'finding_not_found', requestId: req.id });

  const { rows: sources } = await query(
    `SELECT fs.id, fs.engine_id, no.capability_id, no.job_id AS scan_job_id,
            no.title AS observation_title, no.rule_id, no.engine_severity,
            no.location, no.evidence, no.detected_at
       FROM finding_sources fs
       JOIN normalized_observations no ON no.id = fs.normalized_observation_id
      WHERE fs.finding_id = $1`,
    [req.params.id]
  );

  res.json({ finding, sources });
});

const workflowStatusSchema = z.object({
  status: z.enum(['ASSIGNED', 'IN_REMEDIATION', 'READY_FOR_VERIFICATION', 'MITIGATED', 'DEFERRED']),
});

// General workflow transitions (assignment, remediation progress) --
// distinct from the verification-decision endpoints below, which require
// the stronger finding:verify permission.
findingsRouter.patch('/:id/status', requirePermission('finding:update'), async (req, res) => {
  const parsed = workflowStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_request', requestId: req.id });
  }
  await setStatus(req, res, req.params.id, parsed.data.status, null);
});

findingsRouter.post('/:id/confirm', requirePermission('finding:verify'), (req, res) =>
  setStatus(req, res, req.params.id, 'CONFIRMED', 'CONFIRMED')
);

findingsRouter.post('/:id/false-positive', requirePermission('finding:verify'), (req, res) =>
  setStatus(req, res, req.params.id, 'FALSE_POSITIVE', 'REJECTED')
);

findingsRouter.post('/:id/accept-risk', requirePermission('finding:verify'), (req, res) =>
  setStatus(req, res, req.params.id, 'ACCEPTED_RISK', null)
);

const createRemediationSchema = z.object({
  recommendation: z.string().min(1),
  assigneeUserId: z.string().uuid().optional(),
});

findingsRouter.post('/:id/remediations', requirePermission('finding:update'), async (req, res) => {
  const finding = await loadOwnedFinding(req.auth.orgId, req.params.id);
  if (!finding) return res.status(404).json({ error: 'finding_not_found', requestId: req.id });

  const parsed = createRemediationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request', requestId: req.id });

  const remediation = await createRemediation({
    orgId: req.auth.orgId,
    actorUserId: req.auth.userId,
    findingId: req.params.id,
    recommendation: parsed.data.recommendation,
    assigneeUserId: parsed.data.assigneeUserId,
  });
  res.status(201).json({ remediation });
});

findingsRouter.get('/:id/remediations', requirePermission('finding:view'), async (req, res) => {
  const finding = await loadOwnedFinding(req.auth.orgId, req.params.id);
  if (!finding) return res.status(404).json({ error: 'finding_not_found', requestId: req.id });
  res.json({ remediations: await listRemediationsForFinding(req.auth.orgId, req.params.id) });
});

const remediationStatusSchema = z.object({ status: z.enum(['OPEN', 'IN_PROGRESS', 'DONE']) });

findingsRouter.patch('/:id/remediations/:remediationId', requirePermission('finding:update'), async (req, res) => {
  const parsed = remediationStatusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request', requestId: req.id });

  const remediation = await updateRemediationStatus({
    orgId: req.auth.orgId,
    actorUserId: req.auth.userId,
    remediationId: req.params.remediationId,
    status: parsed.data.status,
  });
  if (!remediation) return res.status(404).json({ error: 'remediation_not_found', requestId: req.id });
  res.json({ remediation });
});

// BCI Verify (spec section 35) -- finding:verify, same permission as the
// other verification decisions above, since this is also a verification act.
findingsRouter.post('/:id/verify-fix', requirePermission('finding:verify'), async (req, res) => {
  const finding = await loadOwnedFinding(req.auth.orgId, req.params.id);
  if (!finding) return res.status(404).json({ error: 'finding_not_found', requestId: req.id });

  const outcome = await verifyFix(req.auth.orgId, req.auth.userId, req.params.id);
  res.json(outcome);
});

// AI Decision Support (spec section 41) -- an explanation, never a
// decision. Always returns something: a real AI explanation when
// available, a deterministic plain-language summary otherwise (spec
// section 62, AI unavailable never blocks the base analysis).
findingsRouter.get('/:id/explain', requirePermission('finding:view'), async (req, res) => {
  const finding = await loadOwnedFinding(req.auth.orgId, req.params.id);
  if (!finding) return res.status(404).json({ error: 'finding_not_found', requestId: req.id });

  const outcome = await explainFinding(req.auth.orgId, req.auth.userId, finding);
  res.json(outcome);
});
