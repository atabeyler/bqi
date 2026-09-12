import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { signAccessToken } from '../src/lib/jwt.js';
import { query } from '../src/db/client.js';
import { resetDatabase, createOrg, createUser } from './helpers/db.js';

const app = createApp();

beforeEach(resetDatabase);

async function tokenFor(orgId, roleId, email = `${roleId}@test.local`) {
  const userId = await createUser(orgId, { email, roleId });
  return signAccessToken({ userId, orgId });
}

describe('asset inventory', () => {
  it('viewer cannot create an asset but can list assets', async () => {
    const orgId = await createOrg();
    const token = await tokenFor(orgId, 'viewer');

    const create = await request(app)
      .post('/api/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'example.com', assetType: 'DOMAIN' });
    expect(create.status).toBe(403);

    const list = await request(app).get('/api/v1/assets').set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.assets).toEqual([]);
  });

  it('operator can create, fetch, and update an asset', async () => {
    const orgId = await createOrg();
    const token = await tokenFor(orgId, 'operator');

    const create = await request(app)
      .post('/api/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'example.com', assetType: 'DOMAIN' });
    expect(create.status).toBe(201);
    expect(create.body.asset.criticality).toBe('MEDIUM');

    const assetId = create.body.asset.id;

    const get = await request(app).get(`/api/v1/assets/${assetId}`).set('Authorization', `Bearer ${token}`);
    expect(get.status).toBe(200);
    expect(get.body.identifiers).toEqual([]);

    const update = await request(app)
      .patch(`/api/v1/assets/${assetId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ criticality: 'CRITICAL' });
    expect(update.status).toBe(200);
    expect(update.body.asset.criticality).toBe('CRITICAL');
  });

  it('rejects an invalid asset_type', async () => {
    const orgId = await createOrg();
    const token = await tokenFor(orgId, 'operator');
    const res = await request(app)
      .post('/api/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'x', assetType: 'NOT_A_REAL_TYPE' });
    expect(res.status).toBe(400);
  });

  it('adds identifiers and technologies to an asset', async () => {
    const orgId = await createOrg();
    const token = await tokenFor(orgId, 'operator');
    const create = await request(app)
      .post('/api/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'example.com', assetType: 'DOMAIN' });
    const assetId = create.body.asset.id;

    const idRes = await request(app)
      .post(`/api/v1/assets/${assetId}/identifiers`)
      .set('Authorization', `Bearer ${token}`)
      .send({ identifierType: 'DOMAIN', value: 'example.com' });
    expect(idRes.status).toBe(201);

    const techRes = await request(app)
      .post(`/api/v1/assets/${assetId}/technologies`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'nginx', version: '1.25.0' });
    expect(techRes.status).toBe(201);

    const get = await request(app).get(`/api/v1/assets/${assetId}`).set('Authorization', `Bearer ${token}`);
    expect(get.body.identifiers).toHaveLength(1);
    expect(get.body.technologies).toHaveLength(1);
  });

  it('records a HOSTS relationship between two assets in the same org', async () => {
    const orgId = await createOrg();
    const token = await tokenFor(orgId, 'operator');
    const host = await request(app)
      .post('/api/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'server-1', assetType: 'HOST' });
    const app1 = await request(app)
      .post('/api/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'web-app-1', assetType: 'WEB_APP' });

    const rel = await request(app)
      .post('/api/v1/assets/relationships')
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceAssetId: host.body.asset.id, targetAssetId: app1.body.asset.id, relationshipType: 'HOSTS' });
    expect(rel.status).toBe(201);

    const get = await request(app).get(`/api/v1/assets/${app1.body.asset.id}`).set('Authorization', `Bearer ${token}`);
    expect(get.body.relationships).toHaveLength(1);
    expect(get.body.relationships[0].relationship_type).toBe('HOSTS');
  });

  it('GET /find-by-target finds an existing asset by its real identifier, case-insensitively, and null when there is none', async () => {
    const orgId = await createOrg();
    const token = await tokenFor(orgId, 'operator');
    const create = await request(app)
      .post('/api/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Bold Kimya Web', assetType: 'DOMAIN' });
    await request(app)
      .post(`/api/v1/assets/${create.body.asset.id}/identifiers`)
      .set('Authorization', `Bearer ${token}`)
      .send({ identifierType: 'DOMAIN', value: 'www.boldkimya.com.tr' });

    const found = await request(app)
      .get('/api/v1/assets/find-by-target')
      .query({ value: 'WWW.BOLDKIMYA.COM.TR' })
      .set('Authorization', `Bearer ${token}`);
    expect(found.status).toBe(200);
    expect(found.body.asset.id).toBe(create.body.asset.id);

    const notFound = await request(app)
      .get('/api/v1/assets/find-by-target')
      .query({ value: 'nowhere.example' })
      .set('Authorization', `Bearer ${token}`);
    expect(notFound.body.asset).toBeNull();
  });

  it('find-by-target never leaks a match from a different org', async () => {
    const orgA = await createOrg('A', 'org-a');
    const orgB = await createOrg('B', 'org-b');
    const bToken = await tokenFor(orgB, 'operator', 'op@b.test');
    const aToken = await tokenFor(orgA, 'operator', 'op@a.test');
    const created = await request(app)
      .post('/api/v1/assets')
      .set('Authorization', `Bearer ${bToken}`)
      .send({ name: 'b-secret', assetType: 'DOMAIN' });
    await request(app)
      .post(`/api/v1/assets/${created.body.asset.id}/identifiers`)
      .set('Authorization', `Bearer ${bToken}`)
      .send({ identifierType: 'DOMAIN', value: 'shared-name.example' });

    const found = await request(app)
      .get('/api/v1/assets/find-by-target')
      .query({ value: 'shared-name.example' })
      .set('Authorization', `Bearer ${aToken}`);
    expect(found.body.asset).toBeNull();
  });

  it('creates ACTIVE by default, lists it under the target it registered, and archives/restores without deleting it', async () => {
    const orgId = await createOrg();
    const token = await tokenFor(orgId, 'operator');

    const create = await request(app)
      .post('/api/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'example.com', assetType: 'DOMAIN' });
    expect(create.body.asset.status).toBe('ACTIVE');
    const assetId = create.body.asset.id;

    await request(app)
      .post(`/api/v1/assets/${assetId}/identifiers`)
      .set('Authorization', `Bearer ${token}`)
      .send({ identifierType: 'DOMAIN', value: 'example.com' });

    const list = await request(app).get('/api/v1/assets').set('Authorization', `Bearer ${token}`);
    expect(list.body.assets[0].status).toBe('ACTIVE');
    expect(list.body.assets[0].target).toBe('example.com');

    const archive = await request(app)
      .patch(`/api/v1/assets/${assetId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'ARCHIVED' });
    expect(archive.status).toBe(200);
    expect(archive.body.asset.status).toBe('ARCHIVED');

    const activeOnly = await request(app).get('/api/v1/assets?status=ACTIVE').set('Authorization', `Bearer ${token}`);
    expect(activeOnly.body.assets).toEqual([]);
    const archivedOnly = await request(app).get('/api/v1/assets?status=ARCHIVED').set('Authorization', `Bearer ${token}`);
    expect(archivedOnly.body.assets).toHaveLength(1);

    // Archiving must never touch the asset's own row identity, identifiers,
    // or anything already recorded under its target -- restoring brings it
    // straight back with nothing lost.
    const restore = await request(app)
      .patch(`/api/v1/assets/${assetId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'ACTIVE' });
    expect(restore.body.asset.status).toBe('ACTIVE');
    const getAfterRestore = await request(app).get(`/api/v1/assets/${assetId}`).set('Authorization', `Bearer ${token}`);
    expect(getAfterRestore.body.identifiers).toHaveLength(1);
  });

  describe('asset summary (real derived data, no fabricated scores)', () => {
    it('returns nulls/zeros for an asset with no identifiers and no scans yet -- never invented numbers', async () => {
      const orgId = await createOrg();
      const token = await tokenFor(orgId, 'operator');
      const create = await request(app)
        .post('/api/v1/assets')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'brand-new.example', assetType: 'DOMAIN' });

      const summary = await request(app)
        .get(`/api/v1/assets/${create.body.asset.id}/summary`)
        .set('Authorization', `Bearer ${token}`);
      expect(summary.status).toBe(200);
      expect(summary.body.summary).toEqual({
        targets: [],
        lastScan: null,
        findingCount: 0,
        openFindingCount: 0,
        priorityBreakdown: {},
        riskScore: null,
      });
    });

    it('aggregates real scan_jobs/findings rows matched by the asset\'s registered identifier', async () => {
      const orgId = await createOrg();
      const token = await tokenFor(orgId, 'operator');
      const userId = await createUser(orgId, { email: 'setup@test.local', roleId: 'operator' });

      const create = await request(app)
        .post('/api/v1/assets')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'scanned.example', assetType: 'DOMAIN' });
      const assetId = create.body.asset.id;
      await request(app)
        .post(`/api/v1/assets/${assetId}/identifiers`)
        .set('Authorization', `Bearer ${token}`)
        .send({ identifierType: 'DOMAIN', value: 'scanned.example' });

      await query(
        `INSERT INTO scan_jobs (org_id, requested_by, target, requested_class, status)
         VALUES ($1, $2, 'scanned.example', 'PASSIVE', 'COMPLETED')`,
        [orgId, userId]
      );
      await query(
        `INSERT INTO findings (org_id, correlation_key, category, title, target, status, priority, risk_score)
         VALUES
           ($1, 'k1', 'WEB', 'Open finding', 'scanned.example', 'NEW', 'HIGH_PRIORITY', 60),
           ($1, 'k2', 'WEB', 'Closed finding', 'scanned.example', 'FALSE_POSITIVE', 'PLANNED', 90),
           ($1, 'k3', 'WEB', 'Other org target, must not count', 'someone-elses.example', 'NEW', 'IMMEDIATE', 99)`,
        [orgId]
      );

      const summary = await request(app)
        .get(`/api/v1/assets/${assetId}/summary`)
        .set('Authorization', `Bearer ${token}`);
      expect(summary.status).toBe(200);
      expect(summary.body.summary.targets).toEqual(['scanned.example']);
      expect(summary.body.summary.lastScan.status).toBe('COMPLETED');
      // 2 findings total on this target, but the FALSE_POSITIVE one is
      // closed -- must not count as open, and the 99-risk finding on a
      // different target must never leak into this asset's numbers.
      expect(summary.body.summary.findingCount).toBe(2);
      expect(summary.body.summary.openFindingCount).toBe(1);
      expect(summary.body.summary.priorityBreakdown).toEqual({ HIGH_PRIORITY: 1 });
      expect(summary.body.summary.riskScore).toBe(60);
    });
  });

  describe('cross-tenant isolation', () => {
    it("org A cannot see, fetch, or update org B's asset", async () => {
      const orgA = await createOrg('A', 'org-a');
      const orgB = await createOrg('B', 'org-b');
      const bToken = await tokenFor(orgB, 'operator', 'op@b.test');
      const aToken = await tokenFor(orgA, 'operator', 'op@a.test');

      const created = await request(app)
        .post('/api/v1/assets')
        .set('Authorization', `Bearer ${bToken}`)
        .send({ name: 'b-secret-host', assetType: 'HOST' });
      const assetId = created.body.asset.id;

      const list = await request(app).get('/api/v1/assets').set('Authorization', `Bearer ${aToken}`);
      expect(list.body.assets).toEqual([]);

      const get = await request(app).get(`/api/v1/assets/${assetId}`).set('Authorization', `Bearer ${aToken}`);
      expect(get.status).toBe(404);

      const update = await request(app)
        .patch(`/api/v1/assets/${assetId}`)
        .set('Authorization', `Bearer ${aToken}`)
        .send({ criticality: 'CRITICAL' });
      expect(update.status).toBe(404);

      const summary = await request(app)
        .get(`/api/v1/assets/${assetId}/summary`)
        .set('Authorization', `Bearer ${aToken}`);
      expect(summary.status).toBe(404);
    });

    it('cannot create a relationship spanning two different orgs', async () => {
      const orgA = await createOrg('A', 'org-a');
      const orgB = await createOrg('B', 'org-b');
      const aToken = await tokenFor(orgA, 'operator', 'op@a.test');
      const bToken = await tokenFor(orgB, 'operator', 'op@b.test');

      const aAsset = await request(app)
        .post('/api/v1/assets')
        .set('Authorization', `Bearer ${aToken}`)
        .send({ name: 'a-host', assetType: 'HOST' });
      const bAsset = await request(app)
        .post('/api/v1/assets')
        .set('Authorization', `Bearer ${bToken}`)
        .send({ name: 'b-app', assetType: 'WEB_APP' });

      const rel = await request(app)
        .post('/api/v1/assets/relationships')
        .set('Authorization', `Bearer ${aToken}`)
        .send({ sourceAssetId: aAsset.body.asset.id, targetAssetId: bAsset.body.asset.id, relationshipType: 'HOSTS' });
      expect(rel.status).toBe(404);
    });
  });
});
