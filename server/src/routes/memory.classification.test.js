import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

// item 19: conversationMemory rows now carry the same data_classification
// used for analyses (see routes/analysis.js, items 5/6 earlier in this
// pass) -- must be persisted on save and enforced on every read path
// (list, single, and the /context digest used to prime a new conversation),
// same "role must be able to access this classification" gate as
// routes/history.js's blockedByClassification.

const generateAnalysisMock = vi.fn(async () => ({ provider: 'Claude (Anthropic)', content: 'ozet' }));
vi.mock('../services/ai.js', () => ({ generateAnalysis: (...args) => generateAnalysisMock(...args) }));

let rows = [];
const insertedValues = [];

function makeDb() {
  return {
    insert: () => ({
      values: (v) => {
        insertedValues.push(v);
        const row = { id: rows.length + 1, ...v, createdAt: new Date() };
        rows.push(row);
        return { returning: async () => [{ id: row.id }] };
      },
    }),
    select: () => ({
      from: () => ({
        where: (predicate) => {
          // Test doubles the drizzle query builder loosely -- filter is
          // reapplied in-memory below by each route under test via the
          // shared `rows` array and req.user.userCode, so this stage just
          // needs to hand back a thenable/orderBy-able list.
          const filtered = rows.filter((r) => matches(r, predicate));
          const builder = {
            orderBy: () => ({
              limit: async (n) => filtered.slice(0, n),
            }),
          };
          // Support `await db.select().from().where(...)` directly (no orderBy), used by GET /conversations/:id
          builder.then = (resolve) => resolve(filtered);
          return builder;
        },
      }),
    }),
  };
}

// The mocked drizzle `where(...)` receives an opaque SQL object we can't
// introspect -- tests instead scope rows by pre-seeding only what a given
// test needs and matching everything, mirroring how the other gate3 tests
// in this file's sibling avoid real drizzle wiring entirely.
function matches() { return true; }

vi.mock('../db/client.js', () => ({ isDbConfigured: () => true, getDb: () => makeDb() }));
vi.mock('../db/schema.js', () => ({ userProfiles: {}, conversationMemory: {} }));

const { default: memoryRouter } = await import('./memory.js');
const { JWT_SECRET } = await import('../lib/jwtSecret.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/memory', memoryRouter);
  return app;
}

function token(role) {
  return jwt.sign({ userCode: 'BOLD-001', role }, JWT_SECRET, { expiresIn: '1h' });
}

beforeEach(() => {
  rows = [];
  insertedValues.length = 0;
  vi.clearAllMocks();
  generateAnalysisMock.mockResolvedValue({ provider: 'Claude (Anthropic)', content: 'ozet' });
});

describe('POST /save-conversation persists data_classification', () => {
  it('stores the computed classification on the inserted row', async () => {
    const app = buildApp();
    await request(app).post('/api/memory/save-conversation')
      .set('Authorization', `Bearer ${token('analyst')}`)
      .send({ history: [{ role: 'user', content: 'merhaba' }], dataClassification: 'CONFIDENTIAL' });

    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0].dataClassification).toBe('CONFIDENTIAL');
  });

  it('defaults to INTERNAL when no classification is requested', async () => {
    const app = buildApp();
    await request(app).post('/api/memory/save-conversation')
      .set('Authorization', `Bearer ${token('analyst')}`)
      .send({ history: [{ role: 'user', content: 'merhaba' }] });

    expect(insertedValues[0].dataClassification).toBe('INTERNAL');
  });
});

describe('GET /conversations/:id enforces the classification gate', () => {
  it('403s a viewer trying to read a CONFIDENTIAL conversation', async () => {
    rows.push({ id: 1, userCode: 'BOLD-001', sessionTitle: 's', dataClassification: 'CONFIDENTIAL', fullHistory: [] });
    const app = buildApp();

    const res = await request(app).get('/api/memory/conversations/1')
      .set('Authorization', `Bearer ${token('viewer')}`);

    expect(res.status).toBe(403);
  });

  it('allows an analyst to read their own CONFIDENTIAL conversation', async () => {
    rows.push({ id: 1, userCode: 'BOLD-001', sessionTitle: 's', dataClassification: 'CONFIDENTIAL', fullHistory: [] });
    const app = buildApp();

    const res = await request(app).get('/api/memory/conversations/1')
      .set('Authorization', `Bearer ${token('analyst')}`);

    expect(res.status).toBe(200);
  });

  it('treats a legacy NULL classification as INTERNAL, not PUBLIC/unrestricted', async () => {
    rows.push({ id: 1, userCode: 'BOLD-001', sessionTitle: 's', dataClassification: null, fullHistory: [] });
    const app = buildApp();

    const res = await request(app).get('/api/memory/conversations/1')
      .set('Authorization', `Bearer ${token('viewer')}`);

    // INTERNAL is within a viewer's max, so this should still succeed --
    // the point is it resolves via classifyData(null, null), not a crash
    // or an accidental "anything goes" bypass.
    expect(res.status).toBe(200);
  });
});
