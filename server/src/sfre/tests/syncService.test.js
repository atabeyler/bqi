import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, copyFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { SfreSyncService, syncConfig, kindFromFilename } from '../ingest/syncService.js';
import { validateObservation } from '../data/observation.js';

/** Same contract as PgStore.addObservations (validate, dedupe by hash) without a database. */
class FakeStore {
  constructor() { this.byHash = new Map(); }
  async addObservations(list) {
    const rejected = []; let inserted = 0;
    for (const o of list) { const e = validateObservation(o); if (e.length) { rejected.push({ id: o.id, errors: e }); continue; } if (!this.byHash.has(o.hash)) { this.byHash.set(o.hash, o); inserted++; } }
    return { inserted, duplicates: list.length - rejected.length - inserted, rejected };
  }
}
const xlsx = (rows) => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'S'); return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }); };
const tmp = () => mkdtempSync(path.join(tmpdir(), 'sfre-inbox-'));
const tefasRows = [['Fon Kodu', 'Fon Adı', 'Tarih', 'Fiyat', 'Tedavüldeki Pay Sayısı', 'Kişi Sayısı', 'Fon Toplam Değer'], ['AAL', 'X', 46266, 3.5, 1000, 10, 3500], ['AAL', 'X', 46273, 3.6, 1100, 12, 3960]];

describe('configuration', () => {
  it('nothing is enabled or configured by default; sources report why', () => {
    const svc = new SfreSyncService({ store: new FakeStore(), env: {} });
    expect(svc.cfg.enabled).toBe(false);
    expect(svc.sources().every((s) => s.configured === false)).toBe(true);
    expect(svc.start()).toBe(false);
  });
  it('reads feeds, inbox and interval from env; bad KAP params are surfaced, not ignored', () => {
    const c = syncConfig({ SFRE_SYNC_ENABLED: 'true', SFRE_SYNC_INTERVAL_MIN: '15', SFRE_INBOX_DIR: '/x', SFRE_FEED_BIST_EOD_URL: 'https://h/e.csv', SFRE_FEED_BIST_EOD_TOKEN: 't', SFRE_KAP_SYNC_PARAMS: '{oops' });
    expect(c).toMatchObject({ enabled: true, intervalMs: 900000, inboxDir: '/x' }); expect(c.feeds['bist-eod']).toMatchObject({ url: 'https://h/e.csv', token: 't' }); expect(c.kapParams).toBeNull();
    const svc = new SfreSyncService({ store: new FakeStore(), env: { SFRE_KAP_BASE_URL: 'https://k', SFRE_KAP_API_KEY: 'k', SFRE_KAP_SYNC_PARAMS: '{oops' } });
    expect(svc.sources().find((s) => s.id === 'kap')).toMatchObject({ configured: false, note: expect.stringContaining('not valid JSON') });
  });
  it('file kind comes from the longest matching prefix', () => {
    expect(kindFromFilename('tefas_2026-09.xlsx')).toBe('tefas'); expect(kindFromFilename('BIST-EOD_20260930.csv')).toBe('bist-eod'); expect(kindFromFilename('free-float.xlsx')).toBe('free-float'); expect(kindFromFilename('random.xlsx')).toBeNull();
  });
});

describe('inbox (TEFAS exports dropped by hand or by a scheduled download)', () => {
  it('imports once per content, ignores renames and re-drops, reports unrecognised and failing files', async () => {
    const dir = tmp(); const store = new FakeStore();
    writeFileSync(path.join(dir, 'tefas_a.xlsx'), xlsx(tefasRows));
    writeFileSync(path.join(dir, 'mystery.xlsx'), xlsx([['a', 'b', 'c']]));
    writeFileSync(path.join(dir, 'holdings_bad.csv'), 'not,the,right\n1,2,3\n');
    writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
    const svc = new SfreSyncService({ store, env: { SFRE_INBOX_DIR: dir } });
    const r1 = (await svc.syncInbox());
    expect(r1).toMatchObject({ ok: true, files: 3, alreadySeen: 0, unrecognised: ['mystery.xlsx'] }); expect(r1.inserted).toBeGreaterThan(0);
    expect(r1.imported + r1.failed.length).toBe(2); // tefas_a imports; holdings_bad either fails loudly or imports zero rows, never invents data
    copyFileSync(path.join(dir, 'tefas_a.xlsx'), path.join(dir, 'tefas_renamed.xlsx'));
    const r2 = await svc.syncInbox(); expect(r2).toMatchObject({ inserted: 0 }); expect(r2.alreadySeen).toBeGreaterThanOrEqual(2);
    expect(existsSync(path.join(dir, '.sfre-processed.json'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
  it('a missing inbox directory is created, not an error', async () => {
    const dir = path.join(tmp(), 'new'); const svc = new SfreSyncService({ store: new FakeStore(), env: { SFRE_INBOX_DIR: dir } });
    expect(await svc.syncInbox()).toMatchObject({ ok: true, files: 0 }); expect(existsSync(dir)).toBe(true);
  });
});

describe('authorised HTTP feeds', () => {
  const resp = (status, body) => ({ ok: status < 400, status, arrayBuffer: async () => body });
  it('downloads with the configured credential and imports through the same validated path', async () => {
    let seen; const fetchImpl = async (url, o) => { seen = { url, headers: o.headers }; return resp(200, xlsx(tefasRows)); };
    const store = new FakeStore(); const svc = new SfreSyncService({ store, fetchImpl, env: { SFRE_FEED_TEFAS_URL: 'https://feed/t.xlsx', SFRE_FEED_TEFAS_TOKEN: 'sek' } });
    const r = await svc.syncFeed('tefas'); expect(r.ok).toBe(true); expect(r.inserted).toBeGreaterThan(0);
    expect(seen.headers.Authorization).toBe('Bearer sek');
    expect((await svc.syncFeed('tefas')).inserted).toBe(0); // idempotent
  });
  it('auth failures and HTTP errors are reported per source and never throw out of the sync', async () => {
    const svc = new SfreSyncService({ store: new FakeStore(), fetchImpl: async () => resp(403), env: { SFRE_FEED_HOLDINGS_URL: 'https://x' } });
    expect(await svc.syncFeed('holdings')).toMatchObject({ ok: false, code: 'AUTH' });
    const svc2 = new SfreSyncService({ store: new FakeStore(), fetchImpl: async () => resp(500), env: { SFRE_FEED_HOLDINGS_URL: 'https://x' } });
    expect(await svc2.syncFeed('holdings')).toMatchObject({ ok: false, code: 'HTTP' });
  });
  it('an unconfigured feed is skipped, never invented', async () => {
    expect(await new SfreSyncService({ store: new FakeStore(), env: {} }).syncFeed('bist-eod')).toMatchObject({ ok: true, skipped: 'not configured' });
  });
});

describe('KAP / MKK API', () => {
  it('pulls disclosures with the configured params and stores them as point-in-time observations', async () => {
    const calls = [];
    const fetchImpl = async (url) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => [{ disclosureIndex: 1, publishDate: '30.09.2026 18:05:00', stockCode: 'THYAO', title: 'x' }, { title: 'no id' }] }; };
    const { KapClient } = await import('../ingest/kap.js');
    const kap = new KapClient({ config: { baseUrl: 'https://kap/api', apiKey: 'k', authHeader: 'Authorization', authScheme: 'Bearer', timeoutMs: 1000, minIntervalMs: 0 }, fetchImpl });
    const svc = new SfreSyncService({ store: new FakeStore(), kapClient: kap, env: { SFRE_KAP_SYNC_PARAMS: '{"fromIndex":100}' } });
    const r = await svc.syncKap(); expect(r).toMatchObject({ ok: true, total: 2, accepted: 1, inserted: 1, rejectedByReason: { NO_ID: 1 } }); expect(calls[0]).toContain('fromIndex=100');
  });
});

describe('runAll / status', () => {
  it('is single-flight, runs every source and records last results', async () => {
    const dir = tmp(); writeFileSync(path.join(dir, 'tefas_a.xlsx'), xlsx(tefasRows));
    const svc = new SfreSyncService({ store: new FakeStore(), env: { SFRE_INBOX_DIR: dir } });
    const p1 = svc.runAll(); const p2 = svc.runAll(); expect(p1).toBe(p2);
    const res = await p1; expect(Object.keys(res)).toEqual(['evds', 'kap', 'feed:tefas', 'feed:bist-eod', 'feed:free-float', 'feed:holdings', 'inbox']);
    const st = svc.status(); expect(st.running).toBe(false); expect(st.sources.find((s) => s.id === 'inbox').last).toMatchObject({ ok: true, imported: 1 });
    rmSync(dir, { recursive: true, force: true });
  });
});

// Real TEFAS exports downloaded from tefas.gov.tr (kept outside the repo; heavy, so opt-in: SFRE_REAL_DATA=1 npx vitest run src/sfre/tests/syncService.test.js).
const RAW = path.join(homedir(), 'sfre-data', 'raw');
const realFiles = existsSync(RAW) ? readdirSync(RAW).filter((f) => /^tefas_.*\.xlsx$/.test(f)).sort() : [];
(realFiles.length && process.env.SFRE_REAL_DATA === '1' ? describe : describe.skip)('REAL TEFAS exports through the sync inbox (no database, in-memory store)', () => {
  it('imports every real monthly file, is idempotent, and yields a consistent point-in-time fund universe', async () => {
    const dir = tmp(); for (const f of realFiles) copyFileSync(path.join(RAW, f), path.join(dir, f));
    const store = new FakeStore(); const svc = new SfreSyncService({ store, env: { SFRE_INBOX_DIR: dir } });
    const r1 = await svc.syncInbox();
    expect(r1.ok).toBe(true); expect(r1.failed).toEqual([]); expect(r1.unrecognised).toEqual([]); expect(r1.imported).toBe(realFiles.length);
    expect(r1.inserted).toBeGreaterThan(realFiles.length * 100000);
    const r2 = await svc.syncInbox(); expect(r2).toMatchObject({ imported: 0, inserted: 0, alreadySeen: realFiles.length });
    const obs = [...store.byHash.values()];
    const fields = new Set(obs.map((o) => o.field)); for (const f of ['nav_price', 'units', 'investors', 'aum', 'net_flow_ratio']) expect(fields.has(f)).toBe(true);
    const funds = new Set(obs.map((o) => o.entity)); expect(funds.size).toBeGreaterThan(1500);
    // PIT contract on real data: nothing is available before the day it describes; no blank was turned into zero
    expect(obs.every((o) => Date.parse(o.available_time) >= Date.parse(o.event_time))).toBe(true);
    expect(obs.filter((o) => o.field === 'aum').every((o) => o.value === null || o.value >= 0)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  }, 240000);
});
