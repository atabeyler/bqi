import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { ALL_STRINGS, LANGS, normLang, tr } from '../report/i18n.js';
import { buildReport } from '../report/service.js';
import { renderReportPdf, renderReportDocx, bidiParts } from '../report/exportFiles.js';

const holders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const trial = (b) => ({ funds: 910, alarmLevel: 0.104, baseline: { meanBreadth: 0.044, sdBreadth: 0.015 }, weeks: Array.from({ length: 14 }, (_, i) => ({ date: new Date(Date.UTC(2026, 6, 10) + i * 7 * 86400000).toISOString().slice(0, 10), breadth: i === 13 ? b : 0.05, flagged: i === 13 && b >= 0.104 })) });
const pts = Array.from({ length: 40 }, (_, i) => ({ date: new Date(Date.UTC(2026, 7, 20) + i * 86400000).toISOString().slice(0, 10), value: 40 + i * 0.02 }));
const inputs = (b) => ({ breadth: trial(b), fx: { series: 'TP.DK.USD.A.YTL', flags: [{ date: pts[38].date, move: 0.04, z: 7 }], recent: pts }, coverage: [{ source: 'tefas', field: 'nav', n: 5, first: '2026-07-01', last: '2026-09-25' }], models: [{ id: 'M21', state: 'DEVELOPMENT' }], now: new Date('2026-09-28T10:00:00Z') });

describe('report languages', () => {
  it('has every key in all five languages with the same placeholders as the Turkish text', () => {
    expect(LANGS).toEqual(['tr', 'en', 'de', 'fr', 'ar']);
    for (const l of LANGS) {
      expect(Object.keys(ALL_STRINGS[l]).sort()).toEqual(Object.keys(ALL_STRINGS.tr).sort());
      for (const k of Object.keys(ALL_STRINGS.tr)) { expect(holders(ALL_STRINGS[l][k]), `${l}.${k}`).toBe(holders(ALL_STRINGS.tr[k])); expect(String(ALL_STRINGS[l][k]).trim().length, `${l}.${k} empty`).toBeGreaterThan(0); }
    }
    expect(normLang('AR-SA')).toBe('ar'); expect(normLang('xx')).toBe('tr'); expect(normLang(undefined)).toBe('tr');
    expect(() => tr('en', 'nope')).toThrow();
  });
  it('renders every language to HTML, PDF and Word with the right direction, level wording and no leftover placeholders', async () => {
    for (const l of LANGS) {
      const r = buildReport(inputs(0.21), { lang: l, version: '1' });
      expect(r.html).toContain(`lang="${l}"`); expect(r.html).toContain(l === 'ar' ? 'dir="rtl"' : 'dir="ltr"'); expect(r.html).toContain(ALL_STRINGS[l].level2);
      expect(r.html).not.toMatch(/\{\w+\}/); expect(r.model.rtl).toBe(l === 'ar'); expect(r.model.lang).toBe(l);
      const pdf = await renderReportPdf(r.model); expect(pdf.subarray(0, 5).toString()).toBe('%PDF-'); expect(pdf.length).toBeGreaterThan(5000);
      const xml = await (await JSZip.loadAsync(await renderReportDocx(r.model))).file('word/document.xml').async('string');
      expect(xml).toContain(r.model.id); expect(xml).toContain(ALL_STRINGS[l].level2); if (l === 'ar') expect(xml).toMatch(/<w:bidi\b/); else expect(xml).not.toMatch(/<w:bidi\b/);
    }
  });
  it('words the same assessment per language: English and German differ, numbers use the right decimal mark', () => {
    const en = buildReport(inputs(0.21), { lang: 'en' }).model.sections[0].blocks[0].drivers.join(' '); const de = buildReport(inputs(0.21), { lang: 'de' }).model.sections[0].blocks[0].drivers.join(' ');
    expect(en).toContain('21.0%'); expect(de).toContain('21,0%'); expect(en).not.toBe(de); expect(en).toMatch(/of funds are simultaneously/);
  });
  it('lays Arabic out right-to-left while keeping Latin runs, digits and brackets readable', () => {
    const parts = bidiParts('اتساع الخروج (TEFAS) ثم 10.4%');
    const text = parts.map((p) => p.text).join('|');
    expect(text).toContain('10.4%'); expect(text).toContain('TEFAS'); // Latin/digit runs stay intact and unreversed
    expect(parts[0].text).toBe('10.4%'); // the last logical run is the leftmost visual run
    expect(parts.some((p) => p.ar && p.text.includes('اتساع الخروج'))).toBe(true); // Arabic words stay together so the font can shape them
    expect(bidiParts('abc 123').map((p) => p.text).join('')).toBe('abc 123');
  });
});
