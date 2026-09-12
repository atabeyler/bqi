import http from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { query } from '../src/db/client.js';
import { signAccessToken } from '../src/lib/jwt.js';
import { createOrg, createUser, resetDatabase } from './helpers/db.js';

const app = createApp();
let server;
let origin;

async function tokenFor(orgId, roleId, email = `${roleId}@proof.test`) {
  const userId = await createUser(orgId, { roleId, email });
  return { token: signAccessToken({ userId, orgId }), userId };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<form action="/reflect" method="GET"><input name="q"></form>');
    }
    if (url.pathname === '/reflect') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<main>${url.searchParams.get('q') || ''}</main>`);
    }
    return res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => new Promise((resolve) => server.close(resolve)));
beforeEach(resetDatabase);

describe('Controlled Proof API', () => {
  it('denies non-admin users and rejects arbitrary payload fields', async () => {
    const orgId = await createOrg();
    const viewer = await tokenFor(orgId, 'viewer');
    await request(app).post('/api/v1/controlled-proof/analyze').set('Authorization', `Bearer ${viewer.token}`).send({ targetUrl: origin }).expect(403);

    const admin = await tokenFor(orgId, 'system_admin', 'admin@proof.test');
    await request(app).post('/api/v1/controlled-proof/analyze').set('Authorization', `Bearer ${admin.token}`)
      .send({ targetUrl: origin, payload: '<script>alert(1)</script>' }).expect(400);
  });

  it('queues isolated worker analysis with one Proof ID and no scope approval', async () => {
    const orgId = await createOrg();
    const admin = await tokenFor(orgId, 'system_admin');
    const analyzed = await request(app).post('/api/v1/controlled-proof/analyze').set('Authorization', `Bearer ${admin.token}`)
      .send({ targetUrl: origin }).expect(202);

    expect(analyzed.body.run.status).toBe('ANALYZING');
    expect(analyzed.body.run.proofId).toMatch(/^[A-F0-9]{32}$/);
    expect(analyzed.body.run.validationTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(analyzed.body.run.startedAt).toBeTruthy();
    expect(analyzed.body.run.persistentModification).toBe(false);
    expect((await query('SELECT count(*)::int AS count FROM authorized_scopes WHERE org_id=$1', [orgId])).rows[0].count).toBe(0);

    const jobs = await query('SELECT status, controlled_proof_run_id, selected_engine_ids FROM scan_jobs WHERE org_id=$1', [orgId]);
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]).toMatchObject({ status: 'QUEUED', controlled_proof_run_id: analyzed.body.run.id });
    expect(jobs.rows[0].selected_engine_ids).toEqual(['nuclei', 'http-fuzz', 'intrusive-validation', 'naabu']);
    const normalScans = await request(app).get('/api/v1/scans').set('Authorization', `Bearer ${admin.token}`).expect(200);
    expect(normalScans.body.jobs).toHaveLength(0);
    const actions = await query('SELECT action, metadata FROM audit_events WHERE org_id=$1', [orgId]);
    expect(actions.rows.map((row) => row.action)).toContain('controlled_proof.target_analyzed');
    expect(actions.rows.every((row) => row.metadata.proofId === analyzed.body.run.proofId)).toBe(true);
    expect(analyzed.body.run.publicProofStatus).toBe('UNAVAILABLE');
    await request(app).post(`/api/v1/controlled-proof/${analyzed.body.run.id}/public-proof/start`)
      .set('Authorization', `Bearer ${admin.token}`).send({ durationSeconds: 30 }).expect(409);
    await request(app).post(`/api/v1/controlled-proof/${analyzed.body.run.id}/public-proof/start`)
      .set('Authorization', `Bearer ${admin.token}`).send({ durationSeconds: 31, payload: '<script/>' }).expect(400);
  });

  it('supports real cancel, inspect, archive, and unarchive lifecycle actions', async () => {
    const orgId = await createOrg();
    const admin = await tokenFor(orgId, 'system_admin');
    const inserted = await query(
      `INSERT INTO controlled_proof_runs (
         org_id, actor_user_id, target, normalized_target, proof_id, proof_type, status, started_at
       ) VALUES ($1,$2,'https://example.test','https://example.test/',$3,'WEB_CONTENT_IMPACT','ANALYZING',now()) RETURNING id`,
      [orgId, admin.userId, 'C'.repeat(32)]
    );
    const id = inserted.rows[0].id;

    const cancelled = await request(app).post(`/api/v1/controlled-proof/${id}/cancel`)
      .set('Authorization', `Bearer ${admin.token}`).send({}).expect(200);
    expect(cancelled.body.run.status).toBe('CANCELLED');

    const inspected = await request(app).get(`/api/v1/controlled-proof/${id}`)
      .set('Authorization', `Bearer ${admin.token}`).expect(200);
    expect(inspected.body.run.proofId).toBe('C'.repeat(32));

    await request(app).post(`/api/v1/controlled-proof/${id}/archive`)
      .set('Authorization', `Bearer ${admin.token}`).send({}).expect(200);
    const active = await request(app).get('/api/v1/controlled-proof/history')
      .set('Authorization', `Bearer ${admin.token}`).expect(200);
    expect(active.body.runs).toHaveLength(0);
    const archived = await request(app).get('/api/v1/controlled-proof/history?archived=true')
      .set('Authorization', `Bearer ${admin.token}`).expect(200);
    expect(archived.body.runs).toHaveLength(1);

    await request(app).post(`/api/v1/controlled-proof/${id}/unarchive`)
      .set('Authorization', `Bearer ${admin.token}`).send({}).expect(200);
  });

  it('requires a terminal run and removes a deleted proof from active and archived history', async () => {
    const orgId = await createOrg();
    const admin = await tokenFor(orgId, 'system_admin');
    const inserted = await query(
      `INSERT INTO controlled_proof_runs (
         org_id, actor_user_id, target, normalized_target, proof_id, proof_type, status, started_at
       ) VALUES ($1,$2,'https://demo.test','https://demo.test/',$3,'WEB_CONTENT_IMPACT','ANALYZING',now()) RETURNING id`,
      [orgId, admin.userId, 'D'.repeat(32)]
    );
    const id = inserted.rows[0].id;
    await request(app).delete(`/api/v1/controlled-proof/${id}`).set('Authorization', `Bearer ${admin.token}`).expect(409);
    await request(app).post(`/api/v1/controlled-proof/${id}/cancel`).set('Authorization', `Bearer ${admin.token}`).send({}).expect(200);
    await request(app).post(`/api/v1/controlled-proof/${id}/archive`).set('Authorization', `Bearer ${admin.token}`).send({}).expect(200);
    await request(app).delete(`/api/v1/controlled-proof/${id}`).set('Authorization', `Bearer ${admin.token}`).expect(200);

    expect((await request(app).get('/api/v1/controlled-proof/history').set('Authorization', `Bearer ${admin.token}`)).body.runs).toHaveLength(0);
    expect((await request(app).get('/api/v1/controlled-proof/history?archived=true').set('Authorization', `Bearer ${admin.token}`)).body.runs).toHaveLength(0);
    await request(app).get(`/api/v1/controlled-proof/${id}`).set('Authorization', `Bearer ${admin.token}`).expect(404);
    const stored = await query('SELECT target, normalized_target, security_evidence, evidence_hash, deleted_at FROM controlled_proof_runs WHERE id=$1', [id]);
    expect(stored.rows[0]).toMatchObject({ target: '[deleted]', normalized_target: '[deleted]', security_evidence: {}, evidence_hash: null });
    expect(stored.rows[0].deleted_at).toBeTruthy();
  });

  it('keeps run history tenant isolated', async () => {
    const orgA = await createOrg('A', 'a');
    const orgB = await createOrg('B', 'b');
    const adminA = await tokenFor(orgA, 'system_admin', 'admin@a.test');
    const adminB = await tokenFor(orgB, 'system_admin', 'admin@b.test');
    const analyzed = await request(app).post('/api/v1/controlled-proof/analyze').set('Authorization', `Bearer ${adminA.token}`).send({ targetUrl: origin }).expect(202);
    await request(app).get(`/api/v1/controlled-proof/${analyzed.body.run.id}`).set('Authorization', `Bearer ${adminB.token}`).expect(404);
  });
});
