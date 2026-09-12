import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { signAccessToken } from '../src/lib/jwt.js';
import { resetDatabase, createOrg, createUser } from './helpers/db.js';

const app = createApp();

beforeEach(resetDatabase);

describe('cross-tenant isolation on /api/v1/scopes', () => {
  it("org A's operator cannot see org B's scopes", async () => {
    const orgA = await createOrg('A', 'org-a');
    const orgB = await createOrg('B', 'org-b');

    const bOperatorId = await createUser(orgB, { email: 'op@b.test', roleId: 'operator' });
    const bToken = signAccessToken({ userId: bOperatorId, orgId: orgB });
    await request(app)
      .post('/api/v1/scopes')
      .set('Authorization', `Bearer ${bToken}`)
      .send({ name: 'b-scope', target: 'b-internal.example', allowedScanClasses: ['PASSIVE'], targetType: 'DOMAIN' });

    const aOperatorId = await createUser(orgA, { email: 'op@a.test', roleId: 'operator' });
    const aToken = signAccessToken({ userId: aOperatorId, orgId: orgA });
    const list = await request(app).get('/api/v1/scopes').set('Authorization', `Bearer ${aToken}`);

    expect(list.status).toBe(200);
    expect(list.body.scopes).toHaveLength(0);
  });

  it("a JWT minted for org A cannot be replayed with org B's id to reach org B's data", async () => {
    const orgA = await createOrg('A', 'org-a');
    const orgB = await createOrg('B', 'org-b');
    const userId = await createUser(orgA, { email: 'u@a.test', roleId: 'system_admin' });

    // Forge a token that claims this org-A user belongs to org B.
    const forgedToken = signAccessToken({ userId, orgId: orgB });
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${forgedToken}`);

    // requireAuth looks the user up by (id, org_id) together, so a mismatched
    // pairing finds no row rather than silently trusting the token's claim.
    expect(res.status).toBe(401);
  });

  it("org A's security_admin cannot approve org B's scope by id", async () => {
    const orgA = await createOrg('A', 'org-a');
    const orgB = await createOrg('B', 'org-b');

    const bOperatorId = await createUser(orgB, { email: 'op@b.test', roleId: 'operator' });
    const bToken = signAccessToken({ userId: bOperatorId, orgId: orgB });
    const created = await request(app)
      .post('/api/v1/scopes')
      .set('Authorization', `Bearer ${bToken}`)
      .send({ name: 'b-scope', target: 'b-internal.example', allowedScanClasses: ['PASSIVE'], targetType: 'DOMAIN' });

    const aAdminId = await createUser(orgA, { email: 'admin@a.test', roleId: 'security_admin' });
    const aToken = signAccessToken({ userId: aAdminId, orgId: orgA });
    const approve = await request(app)
      .post(`/api/v1/scopes/${created.body.scope.id}/approve`)
      .set('Authorization', `Bearer ${aToken}`);

    expect(approve.status).toBe(404);
  });
});
