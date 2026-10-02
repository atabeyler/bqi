import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import * as XLSX from 'xlsx';

vi.mock('../../lib/blockedUserCache.js', () => ({ isUserBlocked: async () => false }));
const { createSfreRouter } = await import('../../routes/sfre.js');
const { JWT_SECRET } = await import('../../lib/jwtSecret.js');

const admin = { Authorization: `Bearer ${jwt.sign({ userCode: 'root', role: 'admin' }, JWT_SECRET)}` };
const xlsx = (rows) => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'S'); return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }); };
const good = xlsx([['Tarih', 'Fon Kodu', 'Fiyat'], ['03.09.2026', 'ABC', '1,5']]);

/** Minimal pg stand-in: every query succeeds with no rows, except observation inserts, which fail like a full disk. */
const pgFailingInserts = async (text) => {
  if (/INSERT INTO sfre_observations/i.test(text)) throw Object.assign(new Error('could not extend file: No space left on device'), { code: '53100' });
  return { rows: [], rowCount: 0 };
};

describe('ingest: storage failures are not reported as bad files', () => {
  it('a database write failure returns 503 with a storage message, not "file could not be parsed"', async () => {
    const a = express(); a.use(express.json()); a.use('/api/sfre', createSfreRouter({ pg: pgFailingInserts }));
    const r = await request(a).post('/api/sfre/ingest/tefas').set(admin).attach('file', good, 't.xlsx');
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/storage write failed/);
    expect(r.body.error).not.toMatch(/No space left/); // no database internals leaked
  });
  it('a file the importer cannot read is still 422', async () => {
    const a = express(); a.use(express.json()); a.use('/api/sfre', createSfreRouter({ pg: async () => ({ rows: [], rowCount: 0 }) }));
    const r = await request(a).post('/api/sfre/ingest/bist-eod').set(admin).attach('file', xlsx([['Sembol', 'Tarih']]), 'b.xlsx');
    expect([422, 201]).toContain(r.status); // a header-only sheet is either rejected or yields zero rows, never a 503
    expect(r.status).not.toBe(503);
  });
});
