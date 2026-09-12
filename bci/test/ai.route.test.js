import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { signAccessToken } from '../src/lib/jwt.js';
import { query } from '../src/db/client.js';
import { resetDatabase, createOrg, createUser, insertNormalizedObservation } from './helpers/db.js';
import { correlateJobObservations } from '../src/services/correlation.js';
import { upsertVulnerability } from '../src/services/intelligence.js';

const app = createApp();

beforeEach(resetDatabase);

describe('GET /api/v1/findings/:id/explain', () => {
  it('viewer can request an explanation and always gets one back', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    const jobId = (await query(`INSERT INTO scan_jobs (org_id, requested_by, target, requested_class) VALUES ($1,$2,'t1','PASSIVE') RETURNING id`, [orgId, userId])).rows[0].id;
    await insertNormalizedObservation(orgId, jobId, { engineId: 'semgrep', ruleId: 'eval-detected', location: 'app.js:7', target: 't1' });
    const [findingId] = await correlateJobObservations(orgId, jobId);

    const viewerToken = signAccessToken({ userId: await createUser(orgId, { email: 'v@test.local', roleId: 'viewer' }), orgId });
    const res = await request(app).get(`/api/v1/findings/${findingId}/explain`).set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.text).toBeDefined();
    expect(res.body.source).toBe('deterministic');
  });
});

describe('GET /api/v1/intelligence/vulnerabilities/:cveId/exploitation-claim', () => {
  it('requires intel:view and checks against the local KEV knowledge base', async () => {
    const orgId = await createOrg();
    await upsertVulnerability({ cveId: 'CVE-2099-50001', kev: true });
    const userId = await createUser(orgId, { roleId: 'analyst' });
    const token = signAccessToken({ userId, orgId });

    const res = await request(app)
      .get('/api/v1/intelligence/vulnerabilities/CVE-2099-50001/exploitation-claim')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CONFIRMED');
  });
});
