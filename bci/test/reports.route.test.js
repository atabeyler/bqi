import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { signAccessToken } from '../src/lib/jwt.js';
import { resetDatabase, createOrg, createUser } from './helpers/db.js';

const app = createApp();

beforeEach(resetDatabase);

describe('reports API RBAC', () => {
  it('viewer can view but not generate', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'viewer' });
    const token = signAccessToken({ userId, orgId });

    const list = await request(app).get('/api/v1/reports').set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);

    const gen = await request(app).post('/api/v1/reports').set('Authorization', `Bearer ${token}`).send({ reportType: 'EXECUTIVE' });
    expect(gen.status).toBe(403);
  });

  it('analyst (has report:export) can generate a report and read it back', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'analyst' });
    const token = signAccessToken({ userId, orgId });

    const gen = await request(app).post('/api/v1/reports').set('Authorization', `Bearer ${token}`).send({ reportType: 'EXECUTIVE' });
    expect(gen.status).toBe(201);

    const get = await request(app).get(`/api/v1/reports/${gen.body.report.id}`).set('Authorization', `Bearer ${token}`);
    expect(get.status).toBe(200);
    expect(get.body.report.integrityValid).toBe(true);
  });

  it("org A cannot read org B's report", async () => {
    const orgA = await createOrg('A', 'org-a');
    const orgB = await createOrg('B', 'org-b');
    const bUserId = await createUser(orgB, { email: 'b@b.test', roleId: 'analyst' });
    const bToken = signAccessToken({ userId: bUserId, orgId: orgB });
    const created = await request(app).post('/api/v1/reports').set('Authorization', `Bearer ${bToken}`).send({ reportType: 'AUDIT' });

    const aUserId = await createUser(orgA, { email: 'a@a.test', roleId: 'analyst' });
    const aToken = signAccessToken({ userId: aUserId, orgId: orgA });
    const get = await request(app).get(`/api/v1/reports/${created.body.report.id}`).set('Authorization', `Bearer ${aToken}`);
    expect(get.status).toBe(404);
  });

  it('keeps report archive and deletion distinct and removes deleted content', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'analyst' });
    const token = signAccessToken({ userId, orgId });
    const gen = await request(app).post('/api/v1/reports').set('Authorization', `Bearer ${token}`).send({ reportType: 'FULL', language: 'tr' });
    expect(gen.status).toBe(201);
    expect(gen.body.report.content).toMatchObject({ language: 'tr', presentation: { title: 'Tam BCI Raporu' } });
    const archived = await request(app).post(`/api/v1/reports/${gen.body.report.id}/archive`).set('Authorization', `Bearer ${token}`);
    expect(archived.status).toBe(200);
    const list = await request(app).get('/api/v1/reports').set('Authorization', `Bearer ${token}`);
    expect(list.body.reports).toEqual([]);
    const get = await request(app).get(`/api/v1/reports/${gen.body.report.id}`).set('Authorization', `Bearer ${token}`);
    expect(get.body.report.integrityValid).toBe(true);

    const removed = await request(app).delete(`/api/v1/reports/${gen.body.report.id}`).set('Authorization', `Bearer ${token}`);
    expect(removed.status).toBe(200);
    const deleted = await request(app).get(`/api/v1/reports/${gen.body.report.id}`).set('Authorization', `Bearer ${token}`);
    expect(deleted.status).toBe(404);
  });
});
