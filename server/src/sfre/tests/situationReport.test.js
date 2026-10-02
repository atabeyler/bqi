import { describe, it, expect } from 'vitest';
import { assessSituation, renderReportHtml, reportId, LEVELS } from '../report/situationReport.js';

const weeks = (vals) => vals.map((b, i) => ({ date: new Date(Date.UTC(2026, 7, 7) + i * 7 * 86400000).toISOString().slice(0, 10), breadth: b, flagged: b >= 0.104 }));
const breadth = (vals) => ({ funds: 910, alarmLevel: 0.104, baseline: { meanBreadth: 0.044, sdBreadth: 0.015 }, weeks: weeks(vals) });
const days = (n, end) => Array.from({ length: n }, (_, i) => ({ date: new Date(Date.parse(end) - (n - 1 - i) * 86400000).toISOString().slice(0, 10), value: 40 + i * 0.01 }));
const NOW = new Date('2026-09-26');
const fresh = (vals) => ({ ...breadth(vals), weeks: weeks(vals).map((w, i, arr) => ({ ...w, date: new Date(Date.parse('2026-09-25') - (arr.length - 1 - i) * 7 * 86400000).toISOString().slice(0, 10) })) });

describe('situation report', () => {
  it('is NORMAL when nothing is unusual and says so', () => {
    const a = assessSituation({ breadth: fresh([0.05, 0.045, 0.04]), fx: { series: 'USD', flags: [], recent: days(30, '2026-09-25') }, now: NOW });
    expect(a.level).toBe(LEVELS.NORMAL); expect(a.drivers[0]).toMatch(/alışılmadık/);
  });
  it('has a WATCH tier between the baseline and the alarm level', () => {
    expect(assessSituation({ breadth: breadth([0.05, 0.08]), now: NOW }).level).toBe(LEVELS.WATCH);
  });
  it('is ALARM when the latest week is flagged, and the worse of the two sources wins', () => {
    expect(assessSituation({ breadth: breadth([0.05, 0.11]), now: NOW }).levelTr).toBe('ALARM');
    const fx = { series: 'USD', flags: [{ date: '2026-09-24', move: 0.05, z: 8 }], recent: days(30, '2026-09-25') };
    const a = assessSituation({ breadth: breadth([0.04]), fx, now: NOW }); expect(a.level).toBe(LEVELS.ALARM); expect(a.drivers.join(' ')).toMatch(/24\.09\.2026/);
  });
  it('ignores an FX shock older than 5 days and warns when the fund data is stale', () => {
    const fx = { series: 'USD', flags: [{ date: '2026-09-01', move: 0.05, z: 8 }], recent: days(30, '2026-09-25') };
    const a = assessSituation({ breadth: breadth([0.04]), fx, now: new Date('2026-10-30') });
    expect(a.fx.level).toBe(LEVELS.NORMAL); expect(a.drivers.join(' ')).toMatch(/gün eski/);
  });
  it('handles no data at all', () => {
    const a = assessSituation({ now: NOW }); expect(a.level).toBe(LEVELS.NORMAL); expect(a.drivers[0]).toMatch(/veri yok/i);
    expect(renderReportHtml({ assessment: a })).toContain('Veri yok');
  });
  it('renders a self-contained document, escapes input, and keeps the id stable', () => {
    const b = breadth([0.05, 0.11]); const a = assessSituation({ breadth: b, now: NOW });
    const meta = { generatedAt: '2026-09-26T10:00:00Z', version: '1.0', models: [{ id: '<img onerror=x>', state: 'DEVELOPMENT' }], coverage: [{ source: 'tefas', field: 'nav', n: 5, first: '2026-07-01', last: '2026-09-25' }] };
    const html = renderReportHtml({ assessment: a, breadth: b, meta });
    expect(html).toContain('ALARM'); expect(html).toContain('kalibre edilmemiştir'); expect(html).toContain('<svg');
    expect(html).not.toContain('<img onerror'); expect(html).toContain('&lt;img onerror=x&gt;');
    expect(html).not.toMatch(/<script|https?:\/\//); // self-contained: no scripts, no external loads
    expect(reportId(a, meta)).toBe(reportId(a, meta)); expect(reportId(a, { ...meta, generatedAt: '2026-09-27T00:00:00Z' })).not.toBe(reportId(a, meta));
  });
});
