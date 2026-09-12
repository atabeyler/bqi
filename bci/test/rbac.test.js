import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { signAccessToken } from '../src/lib/jwt.js';
import { resetDatabase, createOrg, createUser } from './helpers/db.js';
import { getPermissionsForUser } from '../src/lib/rbac.js';

const app = createApp();

beforeEach(resetDatabase);

async function tokenFor(orgId, roleId) {
  const userId = await createUser(orgId, { email: `${roleId}@test.local`, roleId });
  return signAccessToken({ userId, orgId });
}

describe('RBAC permission catalog', () => {
  it('viewer cannot create a scope but can view scopes', async () => {
    const orgId = await createOrg();
    const token = await tokenFor(orgId, 'viewer');

    const create = await request(app)
      .post('/api/v1/scopes')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'x', target: 'example.com', allowedScanClasses: ['PASSIVE'], targetType: 'DOMAIN' });
    expect(create.status).toBe(403);

    const list = await request(app).get('/api/v1/scopes').set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
  });

  it('operator can create a scope but cannot approve it', async () => {
    const orgId = await createOrg();
    const token = await tokenFor(orgId, 'operator');

    const create = await request(app)
      .post('/api/v1/scopes')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'x', target: 'example.com', allowedScanClasses: ['PASSIVE'], targetType: 'DOMAIN' });
    expect(create.status).toBe(201);

    const approve = await request(app)
      .post(`/api/v1/scopes/${create.body.scope.id}/approve`)
      .set('Authorization', `Bearer ${token}`);
    expect(approve.status).toBe(403);
  });

  it('security_admin can approve a scope', async () => {
    const orgId = await createOrg();
    const operatorToken = await tokenFor(orgId, 'operator');
    const adminToken = await tokenFor(orgId, 'security_admin');

    const create = await request(app)
      .post('/api/v1/scopes')
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ name: 'x', target: 'example.com', allowedScanClasses: ['PASSIVE'], targetType: 'DOMAIN' });

    const approve = await request(app)
      .post(`/api/v1/scopes/${create.body.scope.id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(approve.status).toBe(200);
    expect(approve.body.scope.status).toBe('APPROVED');
  });

  it('only auditor and system_admin can view the audit log', async () => {
    const orgId = await createOrg();
    const viewerToken = await tokenFor(orgId, 'viewer');
    const auditorToken = await tokenFor(orgId, 'auditor');

    const asViewer = await request(app).get('/api/v1/audit').set('Authorization', `Bearer ${viewerToken}`);
    expect(asViewer.status).toBe(403);

    const asAuditor = await request(app).get('/api/v1/audit').set('Authorization', `Bearer ${auditorToken}`);
    expect(asAuditor.status).toBe(200);
  });

  it('an unrecognized/absent role grants zero permissions (fail closed, never fail open)', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: null });
    const permissions = await getPermissionsForUser(userId, orgId);
    expect(permissions.size).toBe(0);
  });
});
