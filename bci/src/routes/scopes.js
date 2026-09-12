import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/client.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../lib/rbac.js';
import { recordAuditEvent } from '../services/audit.js';
import { evaluateScopeAuthorization } from '../services/policyEngine.js';
import { TARGET_TYPES } from '../lib/targetMatcher.js';

export const scopesRouter = Router();

scopesRouter.use(requireAuth);

const createScopeSchema = z.object({
  name: z.string().min(1),
  target: z.string().min(1),
  targetType: z.enum(TARGET_TYPES),
  allowedScanClasses: z.array(z.enum(['PASSIVE', 'SAFE_ACTIVE', 'AUTHENTICATED', 'RESTRICTED'])).min(1),
  intrusiveness: z.enum(['PASSIVE', 'SAFE_ACTIVE', 'AUTHENTICATED', 'RESTRICTED']).default('PASSIVE'),
  validUntil: z.string().datetime().optional(),
});

scopesRouter.get('/', requirePermission('scope:view'), async (req, res) => {
  const { rows } = await query(
    `SELECT id, name, target, target_type, allowed_scan_classes, intrusiveness, status,
            valid_from, valid_until, created_by, approved_by, approved_at, created_at
       FROM authorized_scopes
      WHERE org_id = $1
      ORDER BY created_at DESC`,
    [req.auth.orgId]
  );
  res.json({ scopes: rows });
});

// Creating a scope only ever produces a PENDING record -- it grants no
// authorization by itself. Only an explicit approve step (a distinct
// permission, scope:approve) turns a scope into something the policy engine
// will honor. This separation of "propose" from "authorize" is deliberate.
scopesRouter.post('/', requirePermission('scope:create'), async (req, res) => {
  const parsed = createScopeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten(), requestId: req.id });
  }
  const { name, target, targetType, allowedScanClasses, intrusiveness, validUntil } = parsed.data;

  const { rows } = await query(
    `INSERT INTO authorized_scopes (org_id, name, target, target_type, allowed_scan_classes, intrusiveness, valid_until, created_by, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING')
     RETURNING id, status`,
    [req.auth.orgId, name, target, targetType, allowedScanClasses, intrusiveness, validUntil ?? null, req.auth.userId]
  );

  await recordAuditEvent({
    orgId: req.auth.orgId,
    actorUserId: req.auth.userId,
    action: 'scope.create',
    targetType: 'authorized_scope',
    targetId: rows[0].id,
    result: 'SUCCESS',
    metadata: { name, target },
  });

  res.status(201).json({ scope: rows[0] });
});

scopesRouter.post('/:id/approve', requirePermission('scope:approve'), async (req, res) => {
  const { rows } = await query(
    `UPDATE authorized_scopes
        SET status = 'APPROVED', approved_by = $1, approved_at = now()
      WHERE id = $2 AND org_id = $3 AND status = 'PENDING'
      RETURNING id, status`,
    [req.auth.userId, req.params.id, req.auth.orgId]
  );

  if (rows.length === 0) {
    return res.status(404).json({ error: 'scope_not_found_or_not_pending', requestId: req.id });
  }

  await recordAuditEvent({
    orgId: req.auth.orgId,
    actorUserId: req.auth.userId,
    action: 'scope.approve',
    targetType: 'authorized_scope',
    targetId: req.params.id,
    result: 'SUCCESS',
  });

  res.json({ scope: rows[0] });
});

scopesRouter.post('/:id/reject', requirePermission('scope:approve'), async (req, res) => {
  const { rows } = await query(
    `UPDATE authorized_scopes
        SET status = 'REJECTED', approved_by = $1, approved_at = now()
      WHERE id = $2 AND org_id = $3 AND status = 'PENDING'
      RETURNING id, status`,
    [req.auth.userId, req.params.id, req.auth.orgId]
  );

  if (rows.length === 0) {
    return res.status(404).json({ error: 'scope_not_found_or_not_pending', requestId: req.id });
  }

  await recordAuditEvent({
    orgId: req.auth.orgId,
    actorUserId: req.auth.userId,
    action: 'scope.reject',
    targetType: 'authorized_scope',
    targetId: req.params.id,
    result: 'SUCCESS',
  });

  res.json({ scope: rows[0] });
});

const evaluateSchema = z.object({
  target: z.string().min(1),
  requestedClass: z.enum(['PASSIVE', 'SAFE_ACTIVE', 'AUTHENTICATED', 'RESTRICTED']),
});

// Lets the future Scan Service (M4) ask "am I allowed to do this" without
// duplicating the policy engine's logic. Any authenticated user who can see
// scopes can also check what the policy engine would decide for a target --
// the check itself reveals nothing an ALLOW/DENY answer wouldn't already.
scopesRouter.post('/evaluate', requirePermission('scope:view'), async (req, res) => {
  const parsed = evaluateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_request', requestId: req.id });
  }
  const decision = await evaluateScopeAuthorization({
    orgId: req.auth.orgId,
    actorUserId: req.auth.userId,
    target: parsed.data.target,
    requestedClass: parsed.data.requestedClass,
  });
  res.json(decision);
});
