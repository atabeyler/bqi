import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

vi.mock('../../lib/blockedUserCache.js', () => ({ isUserBlocked: async () => false }));
const { createSfreRouter } = await import('../../routes/sfre.js');
const { JWT_SECRET } = await import('../../lib/jwtSecret.js');
const { randomSystem } = await import('./helpers.js');

const token = (role, userCode = 'U1') => jwt.sign({ userCode, role }, JWT_SECRET);
function app(opts) { const a = express(); a.use(express.json()); a.use('/api/sfre', createSfreRouter(opts)); return a; }
const body = () => ({ seed: 5, engines: ['cascade', 'concentration', 'anomaly'], fundSystem: randomSystem(2), scenario: { priceShocks: { A0: 0.1 }, redemptions: { F0: { fraction: 0.3 } } } });

describe('/api/sfre', () => {
  it('requires authentication', async () => {
    expect((await request(app()).get('/api/sfre/health')).status).toBe(401);
    expect((await request(app()).post('/api/sfre/runs').send(body())).status).toBe(401);
  });
  it('RBAC: viewers cannot start runs; analysts cannot transition models; admin can read models', async () => {
    const a = app();
    expect((await request(a).post('/api/sfre/runs').set('Authorization', `Bearer ${token('viewer')}`).send(body())).status).toBe(403);
    expect((await request(a).post('/api/sfre/models/M10.cascade/transition').set('Authorization', `Bearer ${token('analyst')}`).send({ to: 'VALIDATION' })).status).toBe(403);
    const m = await request(a).get('/api/sfre/models').set('Authorization', `Bearer ${token('admin')}`);
    expect(m.status).toBe(200); expect(m.body.models.every((x) => x.state === 'DEVELOPMENT')).toBe(true);
  });
  it('analyst run: 201 with results, run record, claims, retail table without composite/recommendation; GET run + explain via ledger', async () => {
    const a = app(); const auth = { Authorization: `Bearer ${token('analyst')}` };
    const r = await request(a).post('/api/sfre/runs').set(auth).send(body());
    expect(r.status).toBe(201); expect(r.body.production_status).toBe('NON_PRODUCTION'); expect(r.body.run.run_id).toMatch(/^run_/); expect(r.body.retail_table.composite_score).toBeNull(); expect(r.body.retail_table.recommendation).toBeNull();
    const casc = r.body.results.find((x) => x.engine === 'cascade'); expect(casc.status).toBe('INSUFFICIENT_OBSERVABILITY'); // debt unobserved for some funds
    const anomaly = r.body.results.find((x) => x.engine === 'anomaly'); expect(anomaly.status).toBe('INSUFFICIENT_OBSERVABILITY'); // section not supplied
    const g = await request(a).get(`/api/sfre/runs/${r.body.run.run_id}`).set(auth); expect(g.status).toBe(200); expect(g.body.run.result_hash).toBe(r.body.run.result_hash);
    const ex = await request(a).get(`/api/sfre/claims/${r.body.claims[casc.result_hash]}/explain`).set(auth);
    expect(ex.status).toBe(200); expect(ex.body.chain_valid).toBe(true); expect(ex.body.path.map((n) => n.kind)).toContain('MODEL');
    expect((await request(a).get('/api/sfre/runs/run_nope').set(auth)).status).toBe(404);
    expect((await request(a).get('/api/sfre/claims/claim_nope/explain').set(auth)).status).toBe(404);
  });
  it('SECURITY: runs, explanations and narratives are visible only to their creator and admins (others get 404)', async () => {
    const a = app(); const alice = { Authorization: `Bearer ${token('analyst', 'alice')}` }; const bob = { Authorization: `Bearer ${token('analyst', 'bob')}` }; const admin = { Authorization: `Bearer ${token('admin', 'root')}` };
    const r = await request(a).post('/api/sfre/runs').set(alice).send(body()); const id = r.body.run.run_id; const claim = Object.values(r.body.claims)[0];
    for (const [h, expected] of [[alice, 200], [bob, 404], [admin, 200]]) {
      expect((await request(a).get(`/api/sfre/runs/${id}`).set(h)).status).toBe(expected);
      expect((await request(a).get(`/api/sfre/claims/${claim}/explain`).set(h)).status).toBe(expected);
      expect((await request(a).post(`/api/sfre/runs/${id}/narrative`).set(h).send({})).status).toBe(expected);
    }
  });
  it('rejects invalid requests with 400 (no stack trace leaked)', async () => {
    const r = await request(app()).post('/api/sfre/runs').set('Authorization', `Bearer ${token('analyst')}`).send({ engines: ['nope'] });
    expect(r.status).toBe(400); expect(JSON.stringify(r.body)).not.toMatch(/at .*\.js/);
  });
  it('governance via API: actor is the authenticated user (body cannot spoof it); transitions need evidence; 409 on violations', async () => {
    const a = app(); const admin = { Authorization: `Bearer ${token('admin', 'ADMIN1')}` };
    const bad = await request(a).post('/api/sfre/models/M10.cascade/transition').set(admin).send({ to: 'APPROVED', actor: { id: 'someone-else', kind: 'human' }, evidence: {} });
    expect(bad.status).toBe(409);
    const ok = await request(a).post('/api/sfre/models/M10.cascade/transition').set(admin).send({ to: 'VALIDATION', evidence: { spec_ref: 'docs' } });
    expect(ok.status).toBe(200); expect(ok.body.model.state).toBe('VALIDATION');
  });
  it('narrative endpoint: invalid LLM text is replaced by the deterministic fallback', async () => {
    const a = app({ explainLlm: async () => 'kesinlikle AL' }); const auth = { Authorization: `Bearer ${token('analyst')}` };
    const r = await request(a).post('/api/sfre/runs').set(auth).send(body());
    const n = await request(a).post(`/api/sfre/runs/${r.body.run.run_id}/narrative`).set(auth).send({});
    expect(n.status).toBe(200); expect(n.body.source).toBe('DETERMINISTIC_FALLBACK'); expect(n.body.text).not.toMatch(/AL\b/);
  });
});
