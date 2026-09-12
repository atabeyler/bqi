import { randomBytes } from 'node:crypto';
import { query } from '../db/client.js';
import { hashPassword } from '../lib/password.js';
import { config } from '../config.js';

const VALID_ROLES = new Set(['viewer', 'analyst', 'operator', 'security_admin', 'auditor', 'system_admin']);

export async function getOrCreateGatewayOrg(slug = config.gatewayOrgSlug) {
  const { rows: existing } = await query('SELECT id FROM organizations WHERE slug = $1', [slug]);
  if (existing.length > 0) return existing[0].id;

  const { rows } = await query(
    'INSERT INTO organizations (name, slug) VALUES ($1, $2) ON CONFLICT (slug) DO NOTHING RETURNING id',
    [slug, slug]
  );
  if (rows.length > 0) return rows[0].id;

  // Lost a create race with a concurrent request -- re-read rather than fail.
  const { rows: retried } = await query('SELECT id FROM organizations WHERE slug = $1', [slug]);
  return retried[0].id;
}

// Idempotent: a returning external user gets the same BCI account back
// (matched by org + synthetic email), with its role kept in sync with
// whatever the gateway currently asserts -- an BQI admin demoted to
// analyst shows up demoted on their next BCI-backed request too, not stuck
// at whatever role they had on first visit.
export async function getOrCreateShadowUser(orgId, { externalId, email, role }) {
  const bciRole = VALID_ROLES.has(role) ? role : 'viewer'; // unrecognized role -> least privilege, never escalated

  const { rows: existing } = await query('SELECT id FROM users WHERE org_id = $1 AND email = $2', [orgId, email]);
  let userId = existing[0]?.id;

  if (!userId) {
    const unusablePassword = await hashPassword(randomBytes(32).toString('hex'));
    const { rows } = await query(
      `INSERT INTO users (org_id, email, password_hash, external_source) VALUES ($1,$2,$3,$4) RETURNING id`,
      [orgId, email, unusablePassword, `gateway:${externalId}`]
    );
    userId = rows[0].id;
  }

  await query('DELETE FROM user_roles WHERE user_id = $1 AND org_id = $2', [userId, orgId]);
  await query('INSERT INTO user_roles (user_id, org_id, role_id) VALUES ($1, $2, $3)', [userId, orgId, bciRole]);

  return userId;
}
