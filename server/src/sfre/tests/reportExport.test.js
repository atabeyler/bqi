import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { buildReport } from '../report/service.js';
import { buildDocModel } from '../report/docModel.js';
import { renderReportPdf, renderReportDocx } from '../report/exportFiles.js';
import { archiveReport, getReport } from '../report/archive.js';

const trial = (b) => ({ funds: 910, alarmLevel: 0.104, baseline: { meanBreadth: 0.044, sdBreadth: 0.015 }, weeks: Array.from({ length: 12 }, (_, i) => ({ date: new Date(Date.UTC(2026, 6, 10) + i * 7 * 86400000).toISOString().slice(0, 10), breadth: i === 11 ? b : 0.05, flagged: i === 11 && b >= 0.104 })) });
const pts = Array.from({ length: 40 }, (_, i) => ({ date: new Date(Date.UTC(2026, 7, 20) + i * 86400000).toISOString().slice(0, 10), value: 40 + i * 0.02 }));
const mk = (b) => buildReport({ breadth: trial(b), fx: { series: 'TP.DK.USD.A.YTL', flags: [{ date: pts[30].date, move: 0.04, z: 7 }], recent: pts }, coverage: [{ source: 'tefas', field: 'nav', n: 5, first: '2026-07-01', last: '2026-09-25' }], models: [{ id: 'M21', state: 'DEVELOPMENT' }], now: new Date('2026-09-28T10:00:00Z') });

describe('report PDF and Word export', () => {
  it('renders a real multi-section PDF', async () => {
    const buf = await renderReportPdf(mk(0.21).model); expect(buf.subarray(0, 5).toString()).toBe('%PDF-'); expect(buf.length).toBeGreaterThan(5000);
    expect(buf.subarray(buf.length - 6).toString()).toContain('%%EOF');
  });
  it('renders a Word file whose text carries the level, document number and limits notice', async () => {
    const r = mk(0.21); const buf = await renderReportDocx(r.model); expect(buf.subarray(0, 2).toString()).toBe('PK');
    const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml').async('string');
    expect(xml).toContain('ALARM'); expect(xml).toContain(r.meta.documentId); expect(xml).toContain('kalibre edilmemiştir'); expect(xml).toContain('VERİ KAPSAMI'); expect(xml).toContain('FON ÇIKIŞI YAYGINLIĞI');
  });
  it('works for NORMAL, for a report with no data, and keeps a stable document id in the model', async () => {
    expect((await renderReportPdf(mk(0.04).model)).length).toBeGreaterThan(3000);
    const empty = buildReport({ breadth: null, fx: null, coverage: [], models: [], now: new Date('2026-09-28T10:00:00Z') });
    expect((await renderReportDocx(empty.model)).length).toBeGreaterThan(2000); expect((await renderReportPdf(empty.model)).length).toBeGreaterThan(2000);
    const r = mk(0.21); expect(r.model.id).toBe(r.meta.documentId);
  });
  it('an archived report can be re-rendered from its snapshot to the same document', async () => {
    const col = {}; const db = { async list(c) { return [...(col[c] || [])]; }, async get(c, id) { return (col[c] || []).find((x) => x.id === id) ?? null; }, async append(c, r) { (col[c] ||= []).push(r); return r; } };
    const r = mk(0.21); const rec = await archiveReport(db, { report: r }); expect(rec.formats).toEqual(['html', 'pdf', 'docx']); expect(rec.data).toBeUndefined();
    const stored = await getReport(db, rec.id); const model = buildDocModel({ assessment: stored.data.assessment, breadth: stored.data.breadth, fx: stored.data.fx, meta: stored.data.meta });
    expect(model.id).toBe(r.model.id); expect(model.sections.map((s) => s.h)).toEqual(r.model.sections.map((s) => s.h));
  });
});
