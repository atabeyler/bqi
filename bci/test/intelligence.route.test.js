import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { signAccessToken } from '../src/lib/jwt.js';
import { resetDatabase, createOrg, createUser } from './helpers/db.js';
import { upsertVulnerability } from '../src/services/intelligence.js';

const app = createApp();

beforeEach(resetDatabase);

async function tokenFor(orgId, roleId) {
  const userId = await createUser(orgId, { email: `${roleId}@test.local`, roleId });
  return signAccessToken({ userId, orgId });
}

describe('GET /api/v1/intelligence/vulnerabilities/:cveId', () => {
  it('rejects a malformed CVE id before it ever reaches the network', async () => {
    const orgId = await createOrg();
    const token = await tokenFor(orgId, 'viewer');
    const res = await request(app)
      .get('/api/v1/intelligence/vulnerabilities/not-a-cve')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it('returns cached data without a permission for intel:manage', async () => {
    const orgId = await createOrg();
    await upsertVulnerability({ cveId: 'CVE-2099-00005', description: 'x' });
    const token = await tokenFor(orgId, 'viewer');

    const res = await request(app)
      .get('/api/v1/intelligence/vulnerabilities/CVE-2099-00005')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.vulnerability.description).toBe('x');
  });

  it('404s for an unknown CVE when no source is reachable', async () => {
    const orgId = await createOrg();
    const token = await tokenFor(orgId, 'viewer');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unreachable'));

    const res = await request(app)
      .get('/api/v1/intelligence/vulnerabilities/CVE-2099-99999')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    fetchSpy.mockRestore();
  });
});

describe('POST /api/v1/intelligence/sync-kev', () => {
  it('requires intel:manage, not just intel:view', async () => {
    const orgId = await createOrg();
    const token = await tokenFor(orgId, 'analyst'); // has intel:view, not intel:manage
    const res = await request(app).post('/api/v1/intelligence/sync-kev').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('security_admin (has intel:manage) can trigger a sync', async () => {
    const orgId = await createOrg();
    const token = await tokenFor(orgId, 'security_admin');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unreachable'));

    const res = await request(app).post('/api/v1/intelligence/sync-kev').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('FAILED'); // network mocked to fail -- still a clean 200 with a reported failure, not a 500
    fetchSpy.mockRestore();
  });
});
