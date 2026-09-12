import { query } from '../db/client.js';

// The permission catalog and role->permission mapping live in
// db/migrations/0002_identity.sql (the database is the source of truth, not
// this file) -- this module only reads it and enforces it per request.

export async function getPermissionsForUser(userId, orgId) {
  const { rows } = await query(
    `SELECT DISTINCT rp.permission_id
       FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE ur.user_id = $1 AND ur.org_id = $2`,
    [userId, orgId]
  );
  return new Set(rows.map((r) => r.permission_id));
}

export function requirePermission(permissionId) {
  return async (req, res, next) => {
    if (!req.auth) {
      return res.status(401).json({ error: 'unauthorized', requestId: req.id });
    }
    const permissions = await getPermissionsForUser(req.auth.userId, req.auth.orgId);
    if (!permissions.has(permissionId)) {
      return res.status(403).json({ error: 'forbidden', permission: permissionId, requestId: req.id });
    }
    next();
  };
}
