import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { signAccessToken } from '../src/lib/jwt.js';
import { query } from '../src/db/client.js';
import { resetDatabase, createOrg, createUser, insertNormalizedObservation } from './helpers/db.js';
import { correlateJobObservations } from '../src/services/correlation.js';

const app = createApp();

beforeEach(resetDatabase);

async function tokenFor(orgId, roleId, email = `${roleId}@test.local`) {
  const userId = await createUser(orgId, { email, roleId });
  return { userId, token: signAccessToken({ userId, orgId }) };
}

async function seedFinding(orgId) {
  const userId = (await query('INSERT INTO users (org_id, email, password_hash) VALUES ($1,$2,$3) RETURNING id', [orgId, `seed-${Math.random()}@x.com`, 'x'])).rows[0].id;
  const jobId = (await query(`INSERT INTO scan_jobs (org_id, requested_by, target, requested_class) VALUES ($1,$2,'t1','PASSIVE') RETURNING id`, [orgId, userId])).rows[0].id;
  await insertNormalizedObservation(orgId, jobId, { engineId: 'semgrep', ruleId: 'eval-detected', location: 'app.js:7', target: 't1' });
  const [findingId] = await correlateJobObservations(orgId, jobId);
  return findingId;
}

describe('findings API', () => {
  it('viewer can list and read but cannot change status', async () => {
    const orgId = await createOrg();
    const findingId = await seedFinding(orgId);
    const { token } = await tokenFor(orgId, 'viewer');

    const list = await request(app).get('/api/v1/findings').set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.findings).toHaveLength(1);

    const get = await request(app).get(`/api/v1/findings/${findingId}`).set('Authorization', `Bearer ${token}`);
    expect(get.status).toBe(200);
    expect(get.body.sources).toHaveLength(1);

    const patch = await request(app)
      .patch(`/api/v1/findings/${findingId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'ASSIGNED' });
    expect(patch.status).toBe(403);
  });

  it('analyst has both finding:update and finding:verify, per the RBAC catalog', async () => {
    const orgId = await createOrg();
    const findingId = await seedFinding(orgId);
    const { token } = await tokenFor(orgId, 'analyst');

    const assign = await request(app)
      .patch(`/api/v1/findings/${findingId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'ASSIGNED' });
    expect(assign.status).toBe(200);

    const fp = await request(app)
      .post(`/api/v1/findings/${findingId}/false-positive`)
      .set('Authorization', `Bearer ${token}`);
    expect(fp.status).toBe(200);
  });

  it('operator (has finding:verify) can mark a finding false-positive', async () => {
    const orgId = await createOrg();
    const findingId = await seedFinding(orgId);
    const { token } = await tokenFor(orgId, 'operator');

    const fp = await request(app)
      .post(`/api/v1/findings/${findingId}/false-positive`)
      .set('Authorization', `Bearer ${token}`);
    expect(fp.status).toBe(200);
    expect(fp.body.finding.status).toBe('FALSE_POSITIVE');
    expect(fp.body.finding.verification_status).toBe('REJECTED');
  });

  it("org A cannot see or act on org B's finding", async () => {
    const orgA = await createOrg('A', 'org-a');
    const orgB = await createOrg('B', 'org-b');
    const findingId = await seedFinding(orgB);
    const { token } = await tokenFor(orgA, 'operator', 'op@a.test');

    const get = await request(app).get(`/api/v1/findings/${findingId}`).set('Authorization', `Bearer ${token}`);
    expect(get.status).toBe(404);

    const fp = await request(app).post(`/api/v1/findings/${findingId}/false-positive`).set('Authorization', `Bearer ${token}`);
    expect(fp.status).toBe(404);
  });
});
