import { describe, it, expect, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { num, parseDay, normHeader, mapColumns } from '../ingest/parse.js';
import { importTefas } from '../ingest/tefas.js';
import { importBistEod, importFreeFloat } from '../ingest/bist.js';
import { importHoldings } from '../ingest/holdings.js';
import { KapClient, normalizeDisclosure, parsePublishTime, kapConfig } from '../ingest/kap.js';
import { PitStore } from '../data/pitStore.js';
import { validateObservation } from '../data/observation.js';

const xlsx = (sheets) => { const wb = XLSX.utils.book_new(); for (const [n, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), n); return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }); };
const D = (d) => Date.UTC(2026, 8, d);

describe('parsing primitives', () => {
  it('REGRESSION: blank/non-numeric is null (never 0 — the existing toNumber() returns 0 for blanks)', () => {
    expect(num('')).toBeNull(); expect(num(null)).toBeNull(); expect(num('abc')).toBeNull(); expect(num('-')).toBeNull(); expect(num(0)).toBe(0);
  });
  it('Turkish/English number formats, dates, headers', () => {
    expect(num('1.234,56')).toBe(1234.56); expect(num('1234.56')).toBe(1234.56); expect(num('12,5')).toBe(12.5); expect(num('%12,5')).toBe(12.5);
    expect(parseDay('03.09.2026')).toBe(D(3)); expect(parseDay('2026-09-03')).toBe(D(3)); expect(parseDay(46268)).toBe(Date.UTC(2026, 8, 3)); expect(parseDay('x')).toBeNull();
    expect(normHeader('Tedavüldeki Pay Sayısı')).toBe('tedavuldeki pay sayisi'); expect(mapColumns(['Tarih', 'Fon Kodu'], { d: { aliases: ['tarih'], required: true }, x: { aliases: ['yok'], required: true } }).missing).toEqual(['x']);
  });
});

describe('idempotent re-import', () => {
  it('REGRESSION: importing the same file twice (different ingestion time) yields identical observation hashes, so the store dedupes', () => {
    const f = xlsx({ 'Genel Bilgiler': [['Tarih', 'Fon Kodu', 'Fiyat'], ['03.09.2026', 'ABC', '1,5']] });
    const a = importTefas(f, { ingestedMs: Date.UTC(2026, 9, 1) }).observations; const b = importTefas(f, { ingestedMs: Date.UTC(2026, 9, 5) }).observations;
    expect(a.map((o) => o.hash)).toEqual(b.map((o) => o.hash)); expect(a[0].ingested_time).not.toBe(b[0].ingested_time);
  });
});

describe('TEFAS import', () => {
  const general = [['Tarih', 'Fon Kodu', 'Fon Adı', 'Fiyat', 'Tedavüldeki Pay Sayısı', 'Kişi Sayısı', 'Fon Toplam Değer'],
    ['03.09.2026', 'abc', 'X', '1,5', 1000000, 500, 1500000], ['10.09.2026', 'ABC', 'X', '1,6', 1200000, 510, 1920000], ['10.09.2026', 'DEF', 'Y', '2,0', '', 10, '']];
  const alloc = [['Tarih', 'Fon Kodu', 'Hisse Senedi', 'Mevduat', 'Repo', 'Diğer'], ['03.09.2026', 'ABC', 60, 20, 10, 10], ['03.09.2026', 'DEF', 90, '', '', 10]];
  const r = importTefas(xlsx({ 'Genel Bilgiler': general, 'Portföy Dağılımı': alloc }), { ingestedMs: Date.UTC(2026, 9, 1) });
  const find = (e, f, d) => r.observations.find((o) => o.entity === e && o.field === f && o.event_time.startsWith(d));
  it('every observation satisfies the PIT contract; availability is event+lag (never the event date) and flagged ESTIMATED', () => {
    expect(r.observations.every((o) => validateObservation(o).length === 0)).toBe(true);
    const o = find('FUND:ABC', 'nav_price', '2026-09-03'); expect(o.value).toBe(1.5); expect(o.available_time).toBe('2026-09-04T00:00:00Z'); expect(o.quality_flags).toContain('ESTIMATED');
  });
  it('blank cells stay UNOBSERVED (no observation emitted), leverage is never emitted', () => {
    expect(find('FUND:DEF', 'units', '2026-09-10')).toBeUndefined(); expect(find('FUND:DEF', 'aum', '2026-09-10')).toBeUndefined();
    expect(r.observations.some((o) => o.field === 'debt_ratio')).toBe(false);
  });
  it('cash_ratio = observed cash-like columns / 100 (VENDOR_DERIVED); none observed -> null/absent', () => {
    expect(find('FUND:ABC', 'cash_ratio', '2026-09-03').value).toBeCloseTo(0.3, 12); expect(find('FUND:ABC', 'equity_share', '2026-09-03').value).toBeCloseTo(0.6, 12);
    expect(find('FUND:DEF', 'cash_ratio', '2026-09-03')).toBeUndefined();
  });
  it('weekly net flow ratio from units, price and prior AUM; PIT view hides it before availability', () => {
    const f = find('FUND:ABC', 'net_flow_ratio', '2026-09-10'); expect(f.value).toBeCloseTo(((1200000 - 1000000) * 1.6) / 1500000, 12);
    const s = new PitStore(); r.observations.forEach((o) => s.add(o));
    expect(s.asOf(D(10)).latest('FUND:ABC', 'net_flow_ratio')).toBeNull(); expect(s.asOf(D(11)).latest('FUND:ABC', 'net_flow_ratio')).not.toBeNull();
  });
  it('sheets without recognisable columns are reported as skipped, never guessed', () => {
    const bad = importTefas(xlsx({ X: [['a', 'b'], [1, 2]] })); expect(bad.observations).toHaveLength(0); expect(bad.skipped[0].reason).toMatch(/required columns/);
  });
});

describe('BIST import', () => {
  it('EOD: close/volume/turnover, availability 18:30 Istanbul same day, blanks unobserved', () => {
    const r = importBistEod(xlsx({ S: [['Sembol', 'Tarih', 'Açılış', 'Kapanış', 'Hacim (Adet)', 'Hacim (TL)'], ['thyao.E', '03.09.2026', '300,5', '305,25', 1000, ''], ['GARAN', '2026-09-03', '', '100', 5, 500]] }));
    const c = r.observations.find((o) => o.entity === 'BIST:THYAO' && o.field === 'close'); expect(c.value).toBe(305.25); expect(c.available_time).toBe('2026-09-03T15:30:00Z');
    expect(r.observations.find((o) => o.entity === 'BIST:THYAO' && o.field === 'turnover')).toBeUndefined(); expect(r.observations.find((o) => o.entity === 'BIST:GARAN' && o.field === 'open')).toBeUndefined();
    expect(r.observations.find((o) => o.entity === 'BIST:GARAN' && o.field === 'volume').value).toBe(5);
  });
  it('free float: ratio normalised to 0-1; shares derived from capital only when not reported (flagged)', () => {
    const r = importFreeFloat(xlsx({ S: [['Kod', 'Tarih', 'Fiili Dolaşım Oranı', 'Ödenmiş Sermaye'], ['AAAA', '03.09.2026', '25,5', 1000000], ['BBBB', '03.09.2026', '', '']] }));
    expect(r.observations.find((o) => o.field === 'free_float_ratio').value).toBeCloseTo(0.255, 12);
    const sh = r.observations.find((o) => o.field === 'free_float_shares'); expect(sh.value).toBeCloseTo(255000, 6); expect(sh.quality_flags).toContain('VENDOR_DERIVED'); expect(r.observations.some((o) => o.entity === 'BIST:BBBB')).toBe(false);
  });
});

describe('holdings import', () => {
  it('REGRESSION: generic alias "kod" must not capture the fund column; groups per fund/date into the canonical encoding; availability = report date + lag', () => {
    const r = importHoldings(xlsx({ S: [['Fon Kodu', 'Tarih', 'Hisse Kodu', 'Ağırlık'], ['abc', '31.08.2026', 'THYAO', '10,5'], ['ABC', '31.08.2026', 'GARAN', 5], ['ABC', '31.08.2026', 'XXXX', '']] }), { lagDays: 12 });
    expect(r.observations).toHaveLength(1); const o = r.observations[0]; expect(o.value).toBe('BIST:THYAO=0.10500000;BIST:GARAN=0.05000000'); expect(o.available_time).toBe('2026-09-12T00:00:00Z');
  });
});

describe('KAP client (schema UNVERIFIED: tolerant normalizer, strict PIT requirements)', () => {
  it('unconfigured client refuses to call; config comes only from env', async () => {
    const c = new KapClient({ config: kapConfig({}) }); expect(c.isConfigured()).toBe(false); await expect(c.call('disclosures')).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    await expect(new KapClient({ config: { baseUrl: 'x', apiKey: 'k', minIntervalMs: 0 } }).call('nope')).rejects.toThrow(/unknown KAP service/);
  });
  it('publication time parsing: Istanbul-local strings are UTC+3; zone-less ISO assumed Istanbul; garbage -> null', () => {
    expect(parsePublishTime('03.09.2026 10:30:00')).toBe(Date.UTC(2026, 8, 3, 7, 30)); expect(parsePublishTime('2026-09-03T10:30:00')).toBe(Date.UTC(2026, 8, 3, 7, 30));
    expect(parsePublishTime('2026-09-03T10:30:00Z')).toBe(Date.UTC(2026, 8, 3, 10, 30)); expect(parsePublishTime('dün')).toBeNull(); expect(parsePublishTime(null)).toBeNull();
  });
  it('records without id or publication time are REJECTED (counted), never guessed; accepted ones carry publish==available time', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [
      { disclosureIndex: 1, publishDate: '03.09.2026 10:30:00', stockCodes: 'THYAO, X', title: 'Sermaye artırımı' }, { disclosureIndex: 2, title: 'no time' }, { publishDate: '03.09.2026 11:00:00', title: 'no id' }] }) }));
    const c = new KapClient({ config: { baseUrl: 'https://gw.example/api', apiKey: 'SECRET', authHeader: 'X-Key', authScheme: '', timeoutMs: 1000, minIntervalMs: 0 }, fetchImpl });
    const r = await c.syncDisclosures({ fromIndex: 1 }, { retrievedMs: Date.UTC(2026, 9, 1) });
    expect(r.total).toBe(3); expect(r.disclosures).toHaveLength(1); expect(r.rejected).toEqual({ NO_PUBLICATION_TIME: 1, NO_ID: 1 });
    const o = r.observations[0]; expect(o.entity).toBe('KAP:THYAO'); expect(o.available_time).toBe(o.published_time); expect(o.quality_flags).not.toContain('ESTIMATED'); expect(validateObservation(o)).toEqual([]);
    const [url, init] = fetchImpl.mock.calls[0]; expect(String(url)).toBe('https://gw.example/api/disclosures?fromIndex=1'); expect(init.headers['X-Key']).toBe('SECRET');
    expect(JSON.stringify(r)).not.toContain('SECRET'); // credentials never reach results
  });
  it('auth failure, HTTP errors and unknown response shapes are distinct, explicit errors', async () => {
    const mk = (res) => new KapClient({ config: { baseUrl: 'https://x', apiKey: 'k', authHeader: 'A', authScheme: 'Bearer', timeoutMs: 1000, minIntervalMs: 0 }, fetchImpl: async () => res });
    await expect(mk({ ok: false, status: 401 }).call('members')).rejects.toMatchObject({ code: 'AUTH' });
    await expect(mk({ ok: false, status: 500 }).call('members')).rejects.toMatchObject({ code: 'HTTP' });
    await expect(mk({ ok: true, status: 200, json: async () => ({ weird: 1 }) }).syncDisclosures()).rejects.toMatchObject({ code: 'SCHEMA' });
  });
  it('polite rate limiting between calls', async () => {
    const sleeps = []; const c = new KapClient({ config: { baseUrl: 'https://x', apiKey: 'k', authHeader: 'A', authScheme: 'Bearer', timeoutMs: 1000, minIntervalMs: 500 }, fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }), sleep: async (ms) => { sleeps.push(ms); } });
    await c.call('members'); await c.call('members'); expect(sleeps.length).toBe(1); expect(sleeps[0]).toBeGreaterThan(0);
    expect(normalizeDisclosure({ disclosureIndex: 9, publishDate: '03.09.2026 10:30:00' }).disclosure.company).toBe('UNKNOWN');
  });
});
