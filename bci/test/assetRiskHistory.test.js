import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { signAccessToken } from '../src/lib/jwt.js';
import { query } from '../src/db/client.js';
import { resetDatabase, createOrg, createUser } from './helpers/db.js';
import { recordAssetRiskSnapshotsForTarget, listAssetRiskHistory } from '../src/services/assetRiskHistory.js';

const app = createApp();

beforeEach(resetDatabase);

async function tokenFor(orgId, roleId) {
  const userId = await createUser(orgId, { email: `${roleId}@test.local`, roleId });
  return { userId, token: signAccessToken({ userId, orgId }) };
}

describe('asset risk history (real, append-only snapshots)', () => {
  it('records a snapshot only for assets whose identifier matches the completed job target', async () => {
    const orgId = await createOrg();
    const { userId, token } = await tokenFor(orgId, 'operator');

    const create = await request(app)
      .post('/api/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'tracked.example', assetType: 'DOMAIN' });
    const assetId = create.body.asset.id;
    await request(app)
      .post(`/api/v1/assets/${assetId}/identifiers`)
      .set('Authorization', `Bearer ${token}`)
      .send({ identifierType: 'DOMAIN', value: 'tracked.example' });

    const jobId = (await query(
      `INSERT INTO scan_jobs (org_id, requested_by, target, requested_class, status) VALUES ($1,$2,'tracked.example','PASSIVE','COMPLETED') RETURNING id`,
      [orgId, userId]
    )).rows[0].id;
    await query(
      `INSERT INTO findings (org_id, correlation_key, category, title, target, status, priority, risk_score)
       VALUES ($1, 'k1', 'WEB', 'f1', 'tracked.example', 'NEW', 'HIGH_PRIORITY', 55)`,
      [orgId]
    );

    await recordAssetRiskSnapshotsForTarget(orgId, 'tracked.example', jobId);
    await recordAssetRiskSnapshotsForTarget(orgId, 'unrelated.example', jobId); // no matching asset -- must be a no-op

    const history = await listAssetRiskHistory(orgId, assetId);
    expect(history).toHaveLength(1);
    expect(history[0].risk_score).toBe(55);
    expect(history[0].open_finding_count).toBe(1);
    expect(history[0].scan_job_id).toBe(jobId);
  });

  it('GET /assets/:id/history returns real snapshots, most recent first, and 404s across orgs', async () => {
    const orgId = await createOrg();
    const { userId, token } = await tokenFor(orgId, 'operator');
    const create = await request(app)
      .post('/api/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'x', assetType: 'DOMAIN' });
    const assetId = create.body.asset.id;
    await request(app)
      .post(`/api/v1/assets/${assetId}/identifiers`)
      .set('Authorization', `Bearer ${token}`)
      .send({ identifierType: 'DOMAIN', value: 'x.example' });

    for (const riskScore of [70, 40]) {
      const jobId = (await query(
        `INSERT INTO scan_jobs (org_id, requested_by, target, requested_class, status) VALUES ($1,$2,'x.example','PASSIVE','COMPLETED') RETURNING id`,
        [orgId, userId]
      )).rows[0].id;
      await query(
        `INSERT INTO findings (org_id, correlation_key, category, title, target, status, priority, risk_score)
         VALUES ($1, $2, 'WEB', 'f', 'x.example', 'NEW', 'HIGH_PRIORITY', $3)`,
        [orgId, `key-${riskScore}`, riskScore]
      );
      await recordAssetRiskSnapshotsForTarget(orgId, 'x.example', jobId);
    }

    const res = await request(app).get(`/api/v1/assets/${assetId}/history`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.history).toHaveLength(2);
    // Most recent first, and each snapshot reflects cumulative open findings
    // at that point in time (2 open findings exist by the second snapshot).
    expect(res.body.history[0].open_finding_count).toBe(2);

    const orgB = await createOrg('B', 'org-b');
    const { token: bToken } = await tokenFor(orgB, 'operator');
    const cross = await request(app).get(`/api/v1/assets/${assetId}/history`).set('Authorization', `Bearer ${bToken}`);
    expect(cross.status).toBe(404);
  });
});
