import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import * as XLSX from 'xlsx';

vi.mock('../../lib/blockedUserCache.js', () => ({ isUserBlocked: async () => false }));
const { createSfreRouter } = await import('../../routes/sfre.js');
const { JWT_SECRET } = await import('../../lib/jwtSecret.js');

const token = (role, userCode = 'U1') => jwt.sign({ userCode, role }, JWT_SECRET);
const xlsx = (rows, sheet = 'S') => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheet); return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }); };
const admin = { Authorization: `Bearer ${token('admin', 'root')}` }; const analyst = { Authorization: `Bearer ${token('analyst', 'ann')}` };
const PG = process.env.SFRE_TEST_DATABASE_URL;

describe('ingest endpoint without a database', () => {
  it('is admin-only and refuses to ingest when no database is configured', async () => {
    const a = express(); a.use(express.json()); a.use('/api/sfre', createSfreRouter());
    expect((await request(a).post('/api/sfre/ingest/tefas').set(analyst).attach('file', xlsx([['a']]), 'x.xlsx')).status).toBe(403);
    expect((await request(a).post('/api/sfre/ingest/tefas').set(admin).attach('file', xlsx([['a']]), 'x.xlsx')).status).toBe(409);
    expect((await request(a).post('/api/sfre/runs/from-data').set(analyst).send({ asOf: '2026-09-01', seed: 1 })).status).toBe(409);
  });
});

(PG ? describe : describe.skip)('data routes on PostgreSQL: upload -> universe -> run from ingested data', () => {
  it('end to end', async () => {
    const pgMod = await import('pg'); const admin0 = new pgMod.default.Pool({ connectionString: PG });
    await admin0.query('DROP SCHEMA IF EXISTS sfre_data_test CASCADE; CREATE SCHEMA sfre_data_test'); await admin0.end();
    const pool = new pgMod.default.Pool({ connectionString: PG, options: '-c search_path=sfre_data_test' });
    const a = express(); a.use(express.json()); a.use('/api/sfre', createSfreRouter({ pg: (t, p) => pool.query(t, p) }));
    const up = (kind, buf, name, h = admin, lag) => { const r = request(a).post(`/api/sfre/ingest/${kind}`).set(h).attach('file', buf, name); return lag === undefined ? r : r.field('lagDays', String(lag)); };

    // validation: wrong kind, wrong content for the extension, bad lag, non-admin
    expect((await up('nope', xlsx([['a']]), 'x.xlsx')).status).toBe(404);
    expect((await up('tefas', Buffer.from('MZ\x90\x00 not a workbook'), 'x.xlsx')).status).toBe(400);
    expect((await up('tefas', xlsx([['a']]), 'x.exe')).status).toBe(400);
    expect((await up('tefas', xlsx([['a']]), 'x.xlsx', admin, 500)).status).toBe(400);
    expect((await up('tefas', xlsx([['a']]), 'x.xlsx', analyst)).status).toBe(403);

    // BIST EOD: 40 days for two tickers
    const eod = [['Sembol', 'Tarih', 'Kapanış', 'Hacim (Adet)']];
    for (let d = 0; d < 40; d++) { const day = new Date(Date.UTC(2026, 7, 1 + d)); const s = `${String(day.getUTCDate()).padStart(2, '0')}.${String(day.getUTCMonth() + 1).padStart(2, '0')}.${day.getUTCFullYear()}`; eod.push(['THYAO', s, 300 + (d % 5), 1000000 + d * 1000], ['GARAN', s, 100 + (d % 3), 2000000]); }
    const r1 = await up('bist-eod', xlsx(eod), 'eod.xlsx'); expect(r1.status).toBe(201); expect(r1.body.inserted).toBe(160); expect(r1.body.rejected).toBe(0);
    // idempotent re-upload
    expect((await up('bist-eod', xlsx(eod), 'eod.xlsx')).body).toMatchObject({ inserted: 0, duplicates: 160 });
    const r2 = await up('holdings', xlsx([['Fon Kodu', 'Tarih', 'Hisse Kodu', 'Ağırlık'], ['ABC', '31.08.2026', 'THYAO', 40], ['ABC', '31.08.2026', 'GARAN', 30], ['DEF', '31.08.2026', 'THYAO', 20], ['DEF', '31.08.2026', 'GARAN', 60]]), 'h.xlsx', admin, 3); expect(r2.status).toBe(201); expect(r2.body.lagDays).toBe(3);
    const wb3 = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb3, XLSX.utils.aoa_to_sheet([['Tarih', 'Fon Kodu', 'Fiyat', 'Fon Toplam Değer'], ['31.08.2026', 'ABC', '1,5', 500000000], ['31.08.2026', 'DEF', '2,5', 800000000], ['31.08.2026', 'GHI', '1', 1]]), 'Genel Bilgiler');
    XLSX.utils.book_append_sheet(wb3, XLSX.utils.aoa_to_sheet([['Tarih', 'Fon Kodu', 'Hisse Senedi', 'Mevduat', 'Repo'], ['31.08.2026', 'ABC', 70, 20, 10], ['31.08.2026', 'DEF', 90, 10, '']]), 'Portföy Dağılımı');
    const r3 = await up('tefas', XLSX.write(wb3, { type: 'buffer', bookType: 'xlsx' }), 't.xlsx'); expect(r3.status).toBe(201);
    expect((await request(a).get('/api/sfre/data/ingests').set(analyst)).body.ingests.length).toBe(4);

    // PIT: before the holdings became available the universe has no funds
    const early = await request(a).get('/api/sfre/data/universe?asOf=2026-08-31').set(analyst); expect(early.body.funds).toEqual([]); expect(early.body.assets).toEqual(['BIST:GARAN', 'BIST:THYAO']);
    const late = await request(a).get('/api/sfre/data/universe?asOf=2026-09-10').set(analyst); expect(late.body.funds).toEqual(['FUND:ABC', 'FUND:DEF']);
    expect((await request(a).get('/api/sfre/data/universe?asOf=garbage').set(analyst)).status).toBe(400);

    const none = await request(a).post('/api/sfre/runs/from-data').set(analyst).send({ asOf: '2026-08-31', seed: 1 }); expect(none.status).toBe(422); expect(none.body.code).toBe('NO_DATA');
    const lateRun0 = await request(a).post('/api/sfre/runs/from-data').set(analyst).send({ asOf: '2026-09-10', seed: 1 }); expect(lateRun0.status).toBe(201);
    const run = await request(a).post('/api/sfre/runs/from-data').set(analyst).send({ asOf: '2026-09-10', seed: 3, engines: ['cascade', 'concentration', 'counterfactual'], scenario: { priceShocks: { 'BIST:THYAO': 0.1 }, redemptions: { 'FUND:ABC': { fraction: 0.2 } } } });
    expect(run.status).toBe(201); expect(run.body.data).toMatchObject({ funds: 2, assets: 2, unobservedLeverageFunds: 2 });
    const casc = run.body.results.find((r) => r.engine === 'cascade'); expect(casc.status).toBe('INSUFFICIENT_OBSERVABILITY'); expect(casc.unobserved).toContain('debt:FUND:ABC');
    expect(casc.value.system.reconciled).toBe(true); expect(casc.value.system.byWho.direct).toBeGreaterThan(0);
    // reproducible: same data + seed -> same result hash
    const again = await request(a).post('/api/sfre/runs/from-data').set(analyst).send({ asOf: '2026-09-10', seed: 3, engines: ['cascade', 'concentration', 'counterfactual'], scenario: { priceShocks: { 'BIST:THYAO': 0.1 }, redemptions: { 'FUND:ABC': { fraction: 0.2 } } } });
    expect(again.body.run.result_hash).toBe(run.body.run.result_hash);
    expect((await request(a).post('/api/sfre/runs/from-data').set(analyst).send({ asOf: '2026-09-10', seed: 1, engines: ['tailRisk'] })).status).toBe(400);
    await pool.end();
  }, 60000);
});
