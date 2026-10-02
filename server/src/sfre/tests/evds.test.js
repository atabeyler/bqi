import { describe, it, expect } from 'vitest';
import { EvdsClient, evdsConfig, evdsItemToObservation, DEFAULT_EVDS_SERIES } from '../ingest/evds.js';
import { SfreSyncService } from '../ingest/syncService.js';
import { validateObservation } from '../data/observation.js';

const CODE = 'TP.DK.USD.A.YTL';
const items = [
  { Tarih: '09-08-2018', TP_DK_USD_A_YTL: '5.8200', UNIXTIME: { $numberLong: '1' } },
  { Tarih: '10-08-2018', TP_DK_USD_A_YTL: '6,5100' },
  { Tarih: '11-08-2018', TP_DK_USD_A_YTL: null }, // holiday: unobserved, never zero
  { Tarih: 'bad-date', TP_DK_USD_A_YTL: '1' },
];
const json = (status, body) => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const cfg = (over = {}) => ({ ...evdsConfig({ TCMB_EVDS_KEY: 'k'.repeat(24), SFRE_EVDS_MIN_INTERVAL_MS: '0' }), ...over });
class FakeStore { constructor() { this.m = new Map(); } async addObservations(l) { let ins = 0; const rej = []; for (const o of l) { const e = validateObservation(o); if (e.length) { rej.push(o.id); continue; } if (!this.m.has(o.hash)) { this.m.set(o.hash, o); ins++; } } return { inserted: ins, duplicates: l.length - rej.length - ins, rejected: rej }; } }

describe('TCMB EVDS importer', () => {
  it('maps items to point-in-time observations: decimal comma, day lag, no value for missing days, flagged ESTIMATED', () => {
    const o1 = evdsItemToObservation(items[0], CODE); const o2 = evdsItemToObservation(items[1], CODE);
    expect(o1).toMatchObject({ entity: `EVDS:${CODE}`, field: 'value', value: 5.82, source: 'tcmb:evds' });
    expect(o2.value).toBe(6.51); expect(o2.event_time).toBe('2018-08-10T00:00:00Z'); expect(o2.available_time).toBe('2018-08-11T00:00:00Z');
    expect(o1.quality_flags).toContain('ESTIMATED'); expect(validateObservation(o1)).toEqual([]);
    expect(evdsItemToObservation(items[2], CODE)).toBeNull(); expect(evdsItemToObservation(items[3], CODE)).toBeNull();
  });
  it('sends the key in a header (never in the URL) and the Turkish date format', async () => {
    let seen; const c = new EvdsClient({ config: cfg(), fetchImpl: async (url, o) => { seen = { url: String(url), headers: o.headers }; return json(200, { items }); } });
    const r = await c.sync({ series: [CODE], startIso: '2018-08-01', endIso: '2018-08-31' });
    expect(seen.url).toContain('startDate=01-08-2018&endDate=31-08-2018'); expect(seen.url).not.toContain('kkkk'); expect(seen.headers.key).toBe('k'.repeat(24));
    expect(r.observations).toHaveLength(2); expect(r.perSeries[CODE]).toMatchObject({ ok: true, items: 4, observations: 2 });
  });
  it('reports a bad key / unknown series per series and still returns the good ones', async () => {
    const c = new EvdsClient({ config: cfg(), fetchImpl: async (url) => (String(url).includes('BAD') ? json(200, '<!DOCTYPE html><html>login</html>') : json(200, { items })) });
    const r = await c.sync({ series: [CODE, 'BAD.CODE'], startIso: '2018-08-01', endIso: '2018-08-31' });
    expect(r.perSeries[CODE].ok).toBe(true); expect(r.perSeries['BAD.CODE']).toMatchObject({ ok: false, code: 'SCHEMA' }); expect(r.observations).toHaveLength(2);
    const bad = await new EvdsClient({ config: cfg(), fetchImpl: async () => json(403, {}) }).sync({ series: [CODE] }); expect(bad.perSeries[CODE]).toMatchObject({ ok: false, code: 'AUTH' });
  });
  it('rejects unsafe series codes and does nothing without a key', async () => {
    const c = new EvdsClient({ config: cfg(), fetchImpl: async () => json(200, { items }) });
    expect((await c.sync({ series: ['x&key=1'] })).perSeries['x&key=1']).toMatchObject({ ok: false, code: 'BAD_CODE' });
    expect(new EvdsClient({ config: evdsConfig({}) }).isConfigured()).toBe(false); expect(evdsConfig({}).series).toEqual([...DEFAULT_EVDS_SERIES]);
  });
});

describe('sync service: evds source', () => {
  it('stores the series idempotently and is skipped, not failed, without a key', async () => {
    const store = new FakeStore();
    const svc = new SfreSyncService({ store, env: { TCMB_EVDS_KEY: 'k'.repeat(24), SFRE_EVDS_SERIES: CODE, SFRE_EVDS_MIN_INTERVAL_MS: '0' }, fetchImpl: async () => json(200, { items }) });
    expect(svc.sources().find((x) => x.id === 'evds')).toMatchObject({ configured: true, series: [CODE] });
    const r1 = await svc.syncEvds(); expect(r1).toMatchObject({ ok: true, inserted: 2 }); expect(r1.series[CODE].ok).toBe(true);
    expect((await svc.syncEvds()).inserted).toBe(0);
    const off = new SfreSyncService({ store: new FakeStore(), env: {} }); expect(await off.syncEvds()).toMatchObject({ ok: true, skipped: 'not configured' });
  });
});
