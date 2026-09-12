import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createFakePool } from './syncTestHelpers.js';

let fakePool;
vi.mock('../services/database.js', () => ({ getPool: () => fakePool }));

const { default: syncRouter } = await import('./sync.js');
const { JWT_SECRET } = await import('../lib/jwtSecret.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sync', syncRouter);
  return app;
}

function token(userCode) {
  return jwt.sign({ userCode }, JWT_SECRET, { expiresIn: '1h' });
}

beforeEach(() => {
  fakePool = createFakePool();
  fakePool._registerDevice('BQI-WIN-AAAAAAAA', 'BOLD-001');
  fakePool._registerDevice('BQI-WIN-BBBBBBBB', 'BOLD-001');
  fakePool._registerDevice('BQI-WIN-CCCCCCCC', 'BOLD-002');
});

describe('POST /api/sync/push', () => {
  it('rejects an unauthorized device', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/sync/push')
      .set('Authorization', `Bearer ${token('BOLD-001')}`)
      .send({ deviceId: 'BQI-WIN-UNKNOWN', operations: [] });
    expect(res.status).toBe(403);
  });

  it('creates a new record and returns it applied with version 1', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/sync/push')
      .set('Authorization', `Bearer ${token('BOLD-001')}`)
      .send({
        deviceId: 'BQI-WIN-AAAAAAAA',
        operations: [{
          operationId: 'op-1', entityType: 'analysis', op: 'create', entityId: 'rec-1',
          payload: { category: 'bddk', title: 'Test raporu', content: 'içerik' },
        }],
      });
    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ status: 'applied', serverVersion: 1, entityId: 'rec-1' });
  });

  it('replays an operationId idempotently instead of double-applying', async () => {
    const app = buildApp();
    const op = {
      operationId: 'op-dup', entityType: 'analysis', op: 'create', entityId: 'rec-dup',
      payload: { category: 'bddk', title: 'x', content: 'y' },
    };
    await request(app).post('/api/sync/push').set('Authorization', `Bearer ${token('BOLD-001')}`)
      .send({ deviceId: 'BQI-WIN-AAAAAAAA', operations: [op] });
    const res = await request(app).post('/api/sync/push').set('Authorization', `Bearer ${token('BOLD-001')}`)
      .send({ deviceId: 'BQI-WIN-AAAAAAAA', operations: [op] });

    expect(res.body.results[0].status).toBe('applied');
    expect(res.body.results[0].replayed).toBe(true);
    expect(fakePool._state.analyses.length).toBe(1); // not duplicated
  });

  it('detects a conflict when baseVersion is stale (two devices editing the same record)', async () => {
    const app = buildApp();
    await request(app).post('/api/sync/push').set('Authorization', `Bearer ${token('BOLD-001')}`)
      .send({
        deviceId: 'BQI-WIN-AAAAAAAA',
        operations: [{ operationId: 'c1', entityType: 'analysis', op: 'create', entityId: 'rec-conflict', payload: { category: 'bddk', title: 't', content: 'c' } }],
      });

    // Device A updates first, bumping version to 2.
    await request(app).post('/api/sync/push').set('Authorization', `Bearer ${token('BOLD-001')}`)
      .send({
        deviceId: 'BQI-WIN-AAAAAAAA',
        operations: [{ operationId: 'u1', entityType: 'analysis', op: 'update', entityId: 'rec-conflict', baseVersion: 1, payload: { title: 'A değişti' } }],
      });

    // Device B still thinks version is 1 -- must be reported as a conflict, not silently overwritten.
    const res = await request(app).post('/api/sync/push').set('Authorization', `Bearer ${token('BOLD-001')}`)
      .send({
        deviceId: 'BQI-WIN-BBBBBBBB',
        operations: [{ operationId: 'u2', entityType: 'analysis', op: 'update', entityId: 'rec-conflict', baseVersion: 1, payload: { title: 'B değişti' } }],
      });

    expect(res.body.results[0].status).toBe('conflict');
    expect(res.body.results[0].serverVersion).toBe(2);
    const stored = fakePool._state.analyses.find((r) => r.client_id === 'rec-conflict');
    expect(stored.title).toBe('A değişti'); // B's write was not applied over A's
  });

  it('never lets one user push against another user\'s record', async () => {
    const app = buildApp();
    await request(app).post('/api/sync/push').set('Authorization', `Bearer ${token('BOLD-001')}`)
      .send({
        deviceId: 'BQI-WIN-AAAAAAAA',
        operations: [{ operationId: 'c1', entityType: 'analysis', op: 'create', entityId: 'rec-isolated', payload: { category: 'bddk', title: 't', content: 'c' } }],
      });

    const res = await request(app).post('/api/sync/push').set('Authorization', `Bearer ${token('BOLD-002')}`)
      .send({
        deviceId: 'BQI-WIN-CCCCCCCC',
        operations: [{ operationId: 'u1', entityType: 'analysis', op: 'update', entityId: 'rec-isolated', baseVersion: 1, payload: { title: 'ele geçirilmiş' } }],
      });

    expect(res.body.results[0].status).toBe('error');
    expect(res.body.results[0].error).toBe('not_found');
  });
});

describe('GET /api/sync/pull', () => {
  it('only returns the authenticated user\'s own records', async () => {
    const app = buildApp();
    await request(app).post('/api/sync/push').set('Authorization', `Bearer ${token('BOLD-001')}`)
      .send({ deviceId: 'BQI-WIN-AAAAAAAA', operations: [{ operationId: 'a', entityType: 'analysis', op: 'create', entityId: 'r1', payload: { category: 'x', title: 't', content: 'c' } }] });
    await request(app).post('/api/sync/push').set('Authorization', `Bearer ${token('BOLD-002')}`)
      .send({ deviceId: 'BQI-WIN-CCCCCCCC', operations: [{ operationId: 'b', entityType: 'analysis', op: 'create', entityId: 'r2', payload: { category: 'x', title: 't2', content: 'c2' } }] });

    const res = await request(app)
      .get('/api/sync/pull?since=0&deviceId=BQI-WIN-AAAAAAAA')
      .set('Authorization', `Bearer ${token('BOLD-001')}`);

    expect(res.status).toBe(200);
    expect(res.body.records).toHaveLength(1);
    expect(res.body.records[0].entityId).toBe('r1');
  });

  it('includes tombstones for soft-deleted records', async () => {
    const app = buildApp();
    await request(app).post('/api/sync/push').set('Authorization', `Bearer ${token('BOLD-001')}`)
      .send({ deviceId: 'BQI-WIN-AAAAAAAA', operations: [{ operationId: 'a', entityType: 'analysis', op: 'create', entityId: 'r3', payload: { category: 'x', title: 't', content: 'c' } }] });
    await request(app).post('/api/sync/push').set('Authorization', `Bearer ${token('BOLD-001')}`)
      .send({ deviceId: 'BQI-WIN-AAAAAAAA', operations: [{ operationId: 'd', entityType: 'analysis', op: 'delete', entityId: 'r3', baseVersion: 1 }] });

    const res = await request(app)
      .get('/api/sync/pull?since=0&deviceId=BQI-WIN-AAAAAAAA')
      .set('Authorization', `Bearer ${token('BOLD-001')}`);

    const rec = res.body.records.find((r) => r.entityId === 'r3');
    expect(rec.deleted).toBe(true);
    expect(rec.payload).toBeNull();
  });
});
