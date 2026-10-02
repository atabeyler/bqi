import { LEVELS, FX_RECENT_DAYS, driverText, reportId } from './assess.js';
import { tr, normLang, RTL_LANGS, fmtPct, fmtDate } from './i18n.js';

/**
 * Format-neutral, language-aware document model of a situation report. HTML, PDF and Word are all rendered from it, so the same words
 * and numbers appear in every format. Charts are carried as data ("bars"/"line") so each renderer draws what it can.
 */
export function buildDocModel({ assessment: a, breadth = null, fx = null, meta = {} }, langIn = 'tr') {
  const lang = normLang(langIn); const T = (k, p) => tr(lang, k, p); const D = (iso) => fmtDate(iso, lang); const P = (x, d) => fmtPct(x, lang, d);
  const id = meta.documentId || reportId(a, meta); const gen = meta.generatedAt || new Date().toISOString();
  const bi = a.breadth; const fi = a.fx; const sections = [];
  const lvl = (l) => T(`level${l}`);
  const drivers = a.items ? a.items.map((i) => driverText(i, lang)) : a.drivers;
  sections.push({ key: 'status', h: T('sStatus'), blocks: [
    { t: 'status', level: a.level, levelText: lvl(a.level), drivers },
    { t: 'table', head: [T('thIndicator'), T('thLevel'), T('thDesc')], levelCol: 1, levels: [bi ? bi.level : null, fi ? fi.level : null], rows: [
      [T('rowBreadth'), bi ? lvl(bi.level) : '–', bi ? T('weekLine', { date: D(bi.date), b: P(bi.breadth), n: bi.funds ?? '?' }) : T('noData')],
      [T('rowFx'), fi ? lvl(fi.level) : '–', fi ? (fi.lastDate ? T('fxLine', { date: D(fi.lastDate), d: FX_RECENT_DAYS, n: fi.recentShocks.length }) : T('noData')) : T('noData')],
    ] },
  ] });
  if (bi) {
    const weeks = (breadth?.weeks || []).slice(-26).map((w) => ({ date: w.date, label: D(w.date), breadth: w.breadth, flagged: !!w.flagged }));
    sections.push({ key: 'breadth', h: T('s1'), blocks: [
      { t: 'p', text: T('p1') },
      { t: 'kpis', items: [{ v: P(bi.breadth), l: T('kpiLast', { date: D(bi.date) }) }, { v: P(bi.baseline), l: T('kpiBase') }, { v: P(bi.alarmLevel), l: T('kpiAlarm') }] },
      { t: 'bars', weeks, alarm: bi.alarmLevel, alarmLabel: T('alarmLine', { a: P(bi.alarmLevel) }), pctLabel: (v) => P(v, 0) },
      { t: 'small', text: T('barsNote') + (bi.watchLevel !== null ? T('watchNote', { w: P(bi.watchLevel) }) : '') },
    ] });
  }
  if (fi && fx?.recent?.length > 1) {
    sections.push({ key: 'fx', h: T('s2'), blocks: [{ t: 'p', text: T('p2', { series: fi.series }) }, { t: 'line', points: fx.recent, flags: (fx.flags || []).map((f) => f.date), first: D(fx.recent[0].date), last: D(fx.recent[fx.recent.length - 1].date) }] });
  }
  const cov = (meta.coverage || []).map((c) => [c.source, c.field, String(c.n), D(String(c.first || '').slice(0, 10)), D(String(c.last || '').slice(0, 10))]);
  sections.push({ key: 'coverage', h: T('s3'), blocks: [{ t: 'table', head: [T('thSource'), T('thField'), T('thCount'), T('thFirst'), T('thLast')], rows: cov.length ? cov : [[T('noRecords'), '', '', '', '']] }] });
  sections.push({ key: 'todo', h: T('s4'), blocks: [{ t: 'ul', items: a.level === LEVELS.NORMAL ? [T('todoNormal')] : [T('todo1'), T('todo2'), T('todo3')] }, { t: 'small', text: T('todoNote') }] });
  const models = meta.models || [];
  sections.push({ key: 'limits', h: T('s5'), blocks: [{ t: 'note', text: T('note', { models: models.length ? models.map((m) => `${m.id}: ${m.state}`).join(', ') : T('unknownModels') }) }] });
  sections.push({ key: 'method', h: T('s6'), blocks: [{ t: 'table', head: [T('thTopic'), T('thDescription')], rows: [[T('mBreadthK'), T('mBreadth')], [T('mFxK'), T('mFx')], [T('mDataK'), T('mData')]] }] });
  return {
    id, lang, rtl: RTL_LANGS.has(lang), title: T('docTitle'), brand: 'BFI', subtitle: T('brandSub'), generatedAt: gen, level: a.level, levelText: lvl(a.level),
    labels: { docNo: T('docNo'), generated: T('generated'), page: (i, n) => T('page', { i, n }) },
    sections, footer: T('footer', { id, date: gen.slice(0, 10), v: meta.version || 'n/a' }), dateText: `${D(gen)} ${gen.slice(11, 16)} UTC`,
  };
}

/** Compact, self-sufficient snapshot stored with an archived report so it can be re-rendered later in any language and format. */
export function snapshotOf({ assessment, breadth, fx, meta }) {
  return {
    assessment, meta: { ...meta },
    breadth: breadth ? { funds: breadth.funds ?? null, alarmLevel: breadth.alarmLevel, baseline: breadth.baseline ?? null, weeks: (breadth.weeks || []).slice(-26) } : null,
    fx: fx ? { series: fx.series, flags: (fx.flags || []).slice(-20), recent: fx.recent } : null,
  };
}
