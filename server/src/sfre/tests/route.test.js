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

describe('worker-thread execution', () => {
  it('runs in a real worker thread (not inline) and returns the same result as inline; invalid input is rejected before the worker', async () => {
    const { runInWorker } = await import('../jobs/runner.js'); const { computeRun } = await import('../pipeline.js');
    const b = body(); const w = await runInWorker(b, null, { inline: false }); const i = computeRun(b);
    expect(w.run.result_hash).toBe(i.run.result_hash);
    await expect(runInWorker({ seed: 'x', engines: [] }, null, { inline: false })).rejects.toThrow(/seed/);
  });
  it('timeout terminates the worker and maps to 504; saturation maps to 429', async () => {
    const a = app({ runner: async () => { throw Object.assign(new Error('t'), { code: 'TIMEOUT' }); } });
    const r = await request(a).post('/api/sfre/runs').set('Authorization', `Bearer ${token('analyst')}`).send(body()); expect(r.status).toBe(504);
    const b = app({ runner: async () => { throw Object.assign(new Error('b'), { code: 'BUSY' }); } });
    expect((await request(b).post('/api/sfre/runs').set('Authorization', `Bearer ${token('analyst')}`).send(body())).status).toBe(429);
    const { runInWorker } = await import('../jobs/runner.js');
    await expect(runInWorker({ seed: 1, engines: ['tailRisk'], tail: { returns: Array.from({ length: 5000 }, () => new Array(100).fill(0.01).map((x, k) => x * (k + 1))), exposures: [new Array(100).fill(1)], fundIds: ['a'], N: 100000 } }, null, { inline: false, timeoutMs: 50 })).rejects.toThrow(/exceeded|size|limits/);
  });
});

const PG = process.env.SFRE_TEST_DATABASE_URL;
(PG ? describe : describe.skip)('PostgreSQL-backed router survives a restart', () => {
  it('runs, claims/explain, governance state and ledger persist across router instances', async () => {
    const pgMod = await import('pg'); const admin0 = new pgMod.default.Pool({ connectionString: PG });
    await admin0.query('DROP SCHEMA IF EXISTS sfre_route_test CASCADE; CREATE SCHEMA sfre_route_test'); await admin0.end(); // own schema: test files run in parallel
    const pool = new pgMod.default.Pool({ connectionString: PG, options: '-c search_path=sfre_route_test' });
    const q = (t, p) => pool.query(t, p);
    const alice = { Authorization: `Bearer ${token('analyst', 'alice')}` }; const admin = { Authorization: `Bearer ${token('admin', 'root')}` };
    const a1 = app({ pg: q });
    const h = await request(a1).get('/api/sfre/health').set(alice); expect(h.body.storage).toBe('postgres');
    const run = await request(a1).post('/api/sfre/runs').set(alice).send(body()); expect(run.status).toBe(201);
    expect((await request(a1).post('/api/sfre/models/M10.cascade/transition').set(admin).send({ to: 'VALIDATION', evidence: { spec_ref: 's' } })).status).toBe(200);
    const claim = Object.values(run.body.claims)[0];
    // "restart": brand-new router + registry + ledger, loaded from the database only
    const a2 = app({ pg: q });
    const g = await request(a2).get(`/api/sfre/runs/${run.body.run.run_id}`).set(alice); expect(g.status).toBe(200); expect(g.body.run.result_hash).toBe(run.body.run.result_hash);
    const ex = await request(a2).get(`/api/sfre/claims/${claim}/explain`).set(alice); expect(ex.status).toBe(200); expect(ex.body.chain_valid).toBe(true);
    expect((await request(a2).get(`/api/sfre/runs/${run.body.run.run_id}`).set({ Authorization: `Bearer ${token('analyst', 'bob')}` })).status).toBe(404);
    const models = await request(a2).get('/api/sfre/models').set(admin); expect(models.body.models.find((m) => m.model_id === 'M10.cascade').state).toBe('VALIDATION');
    // a second run on the restarted instance appends to the SAME chain
    const run2 = await request(a2).post('/api/sfre/runs').set(alice).send({ ...body(), seed: 6 }); expect(run2.status).toBe(201);
    const a3 = app({ pg: q }); expect((await request(a3).get('/api/sfre/health').set(alice)).body.ledger.ok).toBe(true);
    const ds = await request(a3).get('/api/sfre/data/status').set(alice); expect(ds.body.storage).toBe('postgres');
    await pool.end();
  });
});

describe('REGRESSION: found by running the real server', () => {
  it('worker threads do not inherit the server execArgv (a `--import ./src/instrument.js` .ts hook broke every real run)', async () => {
    vi.resetModules();
    const seen = [];
    vi.doMock('node:worker_threads', async () => { const real = await vi.importActual('node:worker_threads'); return { ...real, Worker: class { constructor(f, o) { seen.push(o); return new real.Worker(f, o); } } }; });
    const { runInWorker } = await import('../jobs/runner.js');
    await runInWorker(body(), null, { inline: false });
    expect(seen[0].execArgv).toEqual([]); vi.doUnmock('node:worker_threads');
  });
});

(PG ? describe : describe.skip)('REGRESSION: concurrent first requests (found by a real browser hitting /health and /data/status together)', () => {
  it('single-flight initialisation: parallel first requests on an empty database all succeed', async () => {
    const pgMod = await import('pg'); const admin0 = new pgMod.default.Pool({ connectionString: PG });
    await admin0.query('DROP SCHEMA IF EXISTS sfre_conc_test CASCADE; CREATE SCHEMA sfre_conc_test'); await admin0.end();
    const pool = new pgMod.default.Pool({ connectionString: PG, options: '-c search_path=sfre_conc_test' });
    const a = app({ pg: (t, p) => pool.query(t, p) }); const h = { Authorization: `Bearer ${token('analyst')}` };
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => request(a).get('/api/sfre/health').set(h)));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    // two separate router instances racing schema creation on a fresh schema (multi-instance deploy)
    await pool.query('DROP SCHEMA sfre_conc_test CASCADE; CREATE SCHEMA sfre_conc_test');
    const pool2 = new pgMod.default.Pool({ connectionString: PG, options: '-c search_path=sfre_conc_test' });
    const r2 = await Promise.all([app({ pg: (t, p) => pool2.query(t, p) }), app({ pg: (t, p) => pool2.query(t, p) })].map((x) => request(x).get('/api/sfre/health').set(h)));
    expect(r2.map((r) => r.status)).toEqual([200, 200]);
    await pool.end(); await pool2.end();
  });
  it('a forked ledger (second writer) is detected instead of silently dropped', async () => {
    const { PgStore } = await import('../storage/pgStore.js'); const { EvidenceLedger } = await import('../evidence/ledger.js'); const { makeResult, STATUS, coverageOf } = await import('../../sfre/core/result.js');
    const pgMod = await import('pg'); const admin0 = new pgMod.default.Pool({ connectionString: PG });
    await admin0.query('DROP SCHEMA IF EXISTS sfre_fork_test CASCADE; CREATE SCHEMA sfre_fork_test'); await admin0.end();
    const pool = new pgMod.default.Pool({ connectionString: PG, options: '-c search_path=sfre_fork_test' }); const st = new PgStore((t, p) => pool.query(t, p)); await st.ensureSchema();
    const mk = (v) => { const l = new EvidenceLedger({ clock: () => '2026-01-01T00:00:00Z' }); l.recordClaim({ claim: 'c', result: makeResult({ engine: 'e', modelId: 'm', status: STATUS.MEASURED, value: { v }, coverage: coverageOf(1, 1) }) }); return l; };
    await st.saveLedger(mk(1)); st.persistedLedger = 0; await st.saveLedger(mk(1)); // identical re-save is fine
    st.persistedLedger = 0; await expect(st.saveLedger(mk(2))).rejects.toThrow(/ledger fork detected/);
    await pool.end();
  });
});
