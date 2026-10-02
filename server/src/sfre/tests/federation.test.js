import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { signPackage, verifySignature, validateDocs, docId, MAX_SKEW_MS, MAX_DOC_BYTES } from '../federation/package.js';

vi.mock('../../lib/blockedUserCache.js', () => ({ isUserBlocked: async () => false }));
const { createFederationRouter } = await import('../../routes/sfreFederation.js');
const { createSfreRouter } = await import('../../routes/sfre.js');
const { JWT_SECRET } = await import('../../lib/jwtSecret.js');

const SECRET = 'x'.repeat(40);
const doc = (over = {}) => ({ kind: 'report', title: 'breadth-trial', summary: 's', created_at: '2026-10-02T10:00:00Z', payload: { flaggedWeeks: [7, 8] }, ...over });
function memStore() { const m = new Map(); return { m, get: async (c, id) => m.get(`${c}/${id}`) ?? null, append: async (c, r) => { if (!m.has(`${c}/${r.id}`)) m.set(`${c}/${r.id}`, r); return r; }, list: async (c) => [...m.entries()].filter(([k]) => k.startsWith(`${c}/`)).map(([, v]) => v) }; }
function app(store, secret = SECRET, now = () => Date.now()) { const a = express(); a.use(express.json()); a.use('/api/sfre-federation', createFederationRouter({ getStore: async () => store, secret: () => secret, now })); return a; }
const send = (a, body, { node = 'my-pc', ts = Date.now(), sig } = {}) => request(a).post('/api/sfre-federation/import').set({ 'x-bfi-node': node, 'x-bfi-timestamp': String(ts), 'x-bfi-signature': sig ?? signPackage(body, SECRET, ts) }).send(body);

describe('federation package', () => {
  it('signature covers content and time; any change, a wrong secret or a stale timestamp is refused', () => {
    const body = { docs: [doc()] }; const ts = 1_000_000;
    const sig = signPackage(body, SECRET, ts);
    expect(verifySignature(body, SECRET, ts, sig, ts + 1000).ok).toBe(true);
    expect(verifySignature({ docs: [doc({ title: 'other' })] }, SECRET, ts, sig, ts).reason).toBe('BAD_SIGNATURE');
    expect(verifySignature(body, 'y'.repeat(40), ts, sig, ts).reason).toBe('BAD_SIGNATURE');
    expect(verifySignature(body, SECRET, ts, sig, ts + MAX_SKEW_MS + 1).reason).toBe('STALE_OR_BAD_TIMESTAMP');
    expect(verifySignature(body, 'short', ts, sig, ts).reason).toBe('NOT_CONFIGURED');
    expect(verifySignature(body, SECRET, ts, 'zz', ts).reason).toBe('BAD_SIGNATURE');
  });
  it('validates structure and size; ids are content-addressed per node', () => {
    expect(validateDocs({ docs: [doc()] })).toBeNull();
    expect(validateDocs({ docs: [] })).toMatch(/non-empty/); expect(validateDocs({ docs: [doc({ kind: 'x' })] })).toMatch(/kind/);
    expect(validateDocs({ docs: [doc({ payload: 'x'.repeat(MAX_DOC_BYTES + 1) })] })).toMatch(/payload/);
    expect(docId('a', doc())).toBe(docId('a', doc())); expect(docId('a', doc())).not.toBe(docId('b', doc()));
  });
});

describe('POST /api/sfre-federation/import', () => {
  it('stores signed results, ignores duplicates, and never needs a user session', async () => {
    const store = memStore(); const a = app(store); const body = { docs: [doc(), doc({ kind: 'calibration', title: 'cal', payload: { thresholds: { z: 11.6 } } })] };
    const r1 = await send(a, body); expect(r1.status).toBe(201); expect(r1.body).toMatchObject({ stored: 2, duplicates: 0 });
    const r2 = await send(a, body); expect(r2.body).toMatchObject({ stored: 0, duplicates: 2 });
    expect(store.list('federated')).resolves.toHaveLength(2);
    expect([...store.m.values()][0]).toMatchObject({ node: 'my-pc', kind: 'report' });
  });
  it('rejects bad signatures, stale packages and bad node ids; answers 503 when no secret is configured', async () => {
    const store = memStore(); const body = { docs: [doc()] };
    expect((await send(app(store), body, { sig: 'a'.repeat(64) })).status).toBe(401);
    expect((await send(app(store), body, { ts: Date.now() - 3600000 })).status).toBe(401);
    expect((await send(app(store), body, { node: '../evil' })).status).toBe(400);
    expect((await send(app(store, ''), body)).status).toBe(503);
    expect([...store.m.keys()]).toHaveLength(0);
  });
  it('reports storage failures as 503 without leaking internals', async () => {
    const store = { get: async () => null, append: async () => { throw new Error('disk full: secret detail'); } };
    const r = await send(app(store), { docs: [doc()] }); expect(r.status).toBe(503); expect(r.body.error).not.toMatch(/secret detail/);
  });
});

describe('GET /api/sfre/federation (cloud UI list)', () => {
  it('needs a session, hides payloads in the list, returns one payload on demand', async () => {
    // exercised through the router with a fake pg that serves the federated collection
    const stored = { id: `fed_${'a'.repeat(32)}`, node: 'my-pc', kind: 'report', title: 't', summary: 's', created_at: '2026-10-02T00:00:00Z', payload: { big: [1, 2, 3] } };
    const pg = async (text, params) => {
      if (/FROM sfre_records WHERE collection=\$1 ORDER BY/i.test(text) && params[0] === 'federated') return { rows: [{ record: stored }], rowCount: 1 };
      if (/FROM sfre_records WHERE collection=\$1 AND id=\$2/i.test(text) && params[0] === 'federated') return { rows: [{ record: stored }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    const a = express(); a.use(express.json()); a.use('/api/sfre', createSfreRouter({ pg }));
    const auth = { Authorization: `Bearer ${jwt.sign({ userCode: 'u', role: 'analyst' }, JWT_SECRET)}` };
    expect((await request(a).get('/api/sfre/federation')).status).toBe(401);
    const list = await request(a).get('/api/sfre/federation').set(auth);
    expect(list.status).toBe(200); expect(list.body.items[0]).toMatchObject({ title: 't', node: 'my-pc' }); expect(list.body.items[0].payload).toBeUndefined();
    const one = await request(a).get(`/api/sfre/federation/${stored.id}`).set(auth); expect(one.body.payload).toEqual({ big: [1, 2, 3] });
    expect((await request(a).get('/api/sfre/federation/not-an-id').set(auth)).status).toBe(404);
  });
});
