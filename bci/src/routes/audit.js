import { Router } from 'express';
import { query } from '../db/client.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../lib/rbac.js';

export const auditRouter = Router();

auditRouter.use(requireAuth, requirePermission('audit:view'));

auditRouter.get('/', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const { rows } = await query(
    `SELECT id, actor_user_id, action, target_type, target_id, result, metadata, created_at
       FROM audit_events
      WHERE org_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [req.auth.orgId, limit]
  );
  res.json({ events: rows });
});
