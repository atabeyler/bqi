import { query } from '../db/client.js';
import { hashPassword } from '../lib/password.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// Runs once, only when no organization exists yet -- has no effect on an
// already-initialized deployment even if the bootstrap env vars are left
// set, so there is no way to re-run this to create a second admin.
export async function runBootstrap() {
  const { orgName, adminEmail, adminPassword } = config.bootstrap;
  if (!orgName || !adminEmail || !adminPassword) return;

  const { rows: existing } = await query('SELECT id FROM organizations LIMIT 1');
  if (existing.length > 0) return;

  const slug = slugify(orgName);
  const { rows: orgRows } = await query(
    'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
    [orgName, slug]
  );
  const orgId = orgRows[0].id;

  const passwordHash = await hashPassword(adminPassword);
  const { rows: userRows } = await query(
    'INSERT INTO users (org_id, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
    [orgId, adminEmail, passwordHash]
  );
  const userId = userRows[0].id;

  await query(
    'INSERT INTO user_roles (user_id, org_id, role_id) VALUES ($1, $2, $3)',
    [userId, orgId, 'system_admin']
  );

  logger.info({ orgSlug: slug, adminEmail }, 'BCI bootstrap: organization and system_admin created');
}
