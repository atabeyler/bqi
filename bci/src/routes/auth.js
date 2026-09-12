import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/client.js';
import { verifyPassword } from '../lib/password.js';
import { signAccessToken } from '../lib/jwt.js';
import { requireAuth } from '../middleware/auth.js';
import { loginLimiter } from '../middleware/rateLimit.js';
import { getPermissionsForUser } from '../lib/rbac.js';
import { recordAuditEvent } from '../services/audit.js';

export const authRouter = Router();

const loginSchema = z.object({
  orgSlug: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post('/login', loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_request', requestId: req.id });
  }
  const { orgSlug, email, password } = parsed.data;

  const { rows: orgRows } = await query('SELECT id FROM organizations WHERE slug = $1', [orgSlug]);
  const org = orgRows[0];

  // Same generic failure for "org not found", "user not found", "wrong
  // password", and "blocked" -- distinguishing them lets an attacker
  // enumerate valid org slugs / email addresses.
  const genericFailure = () => res.status(401).json({ error: 'invalid_credentials', requestId: req.id });

  if (!org) {
    await recordAuditEvent({ action: 'auth.login', result: 'FAILURE', metadata: { orgSlug, reason: 'org_not_found' } });
    return genericFailure();
  }

  const { rows: userRows } = await query(
    'SELECT id, org_id, password_hash, blocked, external_source FROM users WHERE org_id = $1 AND email = $2',
    [org.id, email]
  );
  const user = userRows[0];
  // A gateway-provisioned user (external_source set) has an unusable random
  // password and must only ever authenticate via a verified gateway token
  // (routes/gateway.js) -- explicit, not just relying on the random hash
  // never matching.
  if (!user || user.blocked || user.external_source) {
    await recordAuditEvent({ orgId: org.id, action: 'auth.login', result: 'FAILURE', metadata: { email, reason: 'no_user_or_blocked' } });
    return genericFailure();
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    await recordAuditEvent({ orgId: org.id, actorUserId: user.id, action: 'auth.login', result: 'FAILURE', metadata: { reason: 'bad_password' } });
    return genericFailure();
  }

  const token = signAccessToken({ userId: user.id, orgId: user.org_id });
  await recordAuditEvent({ orgId: org.id, actorUserId: user.id, action: 'auth.login', result: 'SUCCESS' });

  res.json({ token });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const permissions = await getPermissionsForUser(req.auth.userId, req.auth.orgId);
  const { rows } = await query(
    `SELECT r.id AS role_id, r.name AS role_name
       FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1 AND ur.org_id = $2`,
    [req.auth.userId, req.auth.orgId]
  );
  res.json({
    userId: req.auth.userId,
    orgId: req.auth.orgId,
    email: req.auth.email,
    roles: rows,
    permissions: [...permissions],
  });
});
