import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

vi.mock('../../lib/blockedUserCache.js', () => ({ isUserBlocked: async () => false }));
const { createSfreRouter, PURGE_CONFIRM } = await import('../../routes/sfre.js');
const { JWT_SECRET } = await import('../../lib/jwtSecret.js');

const as = (role, userCode = 'u') => ({ Authorization: `Bearer ${jwt.sign({ userCode, role }, JWT_SECRET)}` });

/** pg stand-in that records every statement and answers the few reads the purge needs. */
function fakePg({ failDrop = false } = {}) {
  const log = [];
  const fn = async (text, params) => {
    log.push({ text: String(text).replace(/\s+/g, ' ').trim(), params });
    if (/count\(\*\)::int AS n, pg_total_relation_size/i.test(text)) return { rows: [{ n: 1234, bytes: 987654 }], rowCount: 1 };
    if (/DROP TABLE IF EXISTS sfre_observations/i.test(text) && failDrop) throw new Error('permission denied');
    return { rows: [], rowCount: 0 };
  };
  fn.log = log; return fn;
}
const app = (pg) => { const a = express(); a.use(express.json()); a.use('/api/sfre', createSfreRouter(pg ? { pg } : {})); return a; };

describe('POST /api/sfre/data/purge (admin only, explicit confirmation, audited)', () => {
  it('is refused for non-admins and without a database', async () => {
    const pg = fakePg();
    expect((await request(app(pg)).post('/api/sfre/data/purge').set(as('analyst')).send({ confirm: PURGE_CONFIRM })).status).toBe(403);
    expect((await request(app(pg)).post('/api/sfre/data/purge').set(as('viewer')).send({ confirm: PURGE_CONFIRM })).status).toBe(403);
    expect((await request(app()).post('/api/sfre/data/purge').set(as('admin')).send({ confirm: PURGE_CONFIRM })).status).toBe(409);
    expect(pg.log.some((q) => /DROP TABLE/i.test(q.text))).toBe(false);
  });
  it('needs the exact confirmation token; a wrong or missing token deletes nothing', async () => {
    const pg = fakePg();
    expect((await request(app(pg)).post('/api/sfre/data/purge').set(as('admin')).send({})).status).toBe(400);
    expect((await request(app(pg)).post('/api/sfre/data/purge').set(as('admin')).send({ confirm: 'yes' })).status).toBe(400);
    expect(pg.log.some((q) => /DROP TABLE/i.test(q.text))).toBe(false);
  });
  it('drops and recreates only the observations table, then records who purged what', async () => {
    const pg = fakePg();
    const r = await request(app(pg)).post('/api/sfre/data/purge').set(as('admin', 'root')).send({ confirm: PURGE_CONFIRM });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ ok: true, removedRows: 1234, freedBytes: 987654 });
    const drops = pg.log.filter((q) => /DROP TABLE/i.test(q.text));
    expect(drops).toHaveLength(1); expect(drops[0].text).toMatch(/sfre_observations/); expect(drops[0].text).not.toMatch(/sfre_(ledger|records|models)/);
    const dropAt = pg.log.findIndex((q) => /DROP TABLE/i.test(q.text));
    expect(pg.log.slice(dropAt + 1).some((q) => /CREATE TABLE IF NOT EXISTS sfre_observations/i.test(q.text))).toBe(true); // schema re-applied
    const audit = pg.log.find((q) => /INSERT INTO sfre_records/i.test(q.text) && JSON.stringify(q.params).includes('purge_'));
    expect(audit).toBeTruthy(); expect(JSON.stringify(audit.params)).toMatch(/root/);
  });
  it('reports a storage failure honestly and records no purge', async () => {
    const pg = fakePg({ failDrop: true });
    const r = await request(app(pg)).post('/api/sfre/data/purge').set(as('admin')).send({ confirm: PURGE_CONFIRM });
    expect(r.status).toBe(503); expect(r.body.error).not.toMatch(/permission denied/);
    expect(pg.log.some((q) => /INSERT INTO sfre_records/i.test(q.text) && JSON.stringify(q.params).includes('purge_'))).toBe(false);
  });
});
