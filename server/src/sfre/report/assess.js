import { createHash } from 'node:crypto';
import { tr, fmtPct, fmtDate } from './i18n.js';

/**
 * Situation assessment: one level (NORMAL / WATCH / ALARM) and the reasons for it. Pure functions, no I/O.
 * Reasons are kept as structured items (`items`) so they can be worded in any language; `drivers` is the Turkish wording for older callers.
 * The WATCH tier (breadth >= mean + 2 sd of the reference) is a documented convention, not a calibrated rate.
 */
export const LEVELS = Object.freeze({ NORMAL: 0, WATCH: 1, ALARM: 2 });
export const LEVEL_TR = Object.freeze({ 0: 'NORMAL', 1: 'İZLEME', 2: 'ALARM' });
export const FX_RECENT_DAYS = 5;
const DAY = 86400000;

/** Wording of one reason item in `lang`. */
export function driverText(item, lang = 'tr') {
  const p = item.p || {};
  switch (item.k) {
    case 'breadthAlarm': return tr(lang, 'dBreadthAlarm', { b: fmtPct(p.b, lang), alarm: fmtPct(p.alarm, lang), mean: fmtPct(p.mean, lang) });
    case 'breadthWatch': return tr(lang, 'dBreadthWatch', { b: fmtPct(p.b, lang), alarm: fmtPct(p.alarm, lang), mean: fmtPct(p.mean, lang) });
    case 'stale': return tr(lang, 'dStale', { days: p.days });
    case 'fxShock': return tr(lang, 'dFxShock', { date: fmtDate(p.date, lang), move: fmtPct(p.move, lang), z: Math.abs(p.z) });
    case 'noData': return tr(lang, 'dNoData');
    default: return tr(lang, 'dAllNormal');
  }
}

/** breadth: payload of a breadth trial ({weeks, alarmLevel, baseline, funds}); fx: {series, flags, recent:[{date,value}]}. Either may be missing. */
export function assessSituation({ breadth = null, fx = null, now = new Date() } = {}) {
  const items = []; let level = LEVELS.NORMAL; const raise = (l) => { if (l > level) level = l; };
  let breadthInfo = null;
  const w = breadth?.weeks?.length ? breadth.weeks[breadth.weeks.length - 1] : null;
  if (w && Number.isFinite(w.breadth) && Number.isFinite(breadth.alarmLevel)) {
    const m = breadth.baseline?.meanBreadth; const s = breadth.baseline?.sdBreadth; const watchAt = Number.isFinite(m) && Number.isFinite(s) ? m + 2 * s : null;
    const stale = (now.getTime() - Date.parse(`${w.date}T00:00:00Z`)) / DAY;
    const st = w.flagged ? LEVELS.ALARM : (watchAt !== null && w.breadth >= watchAt ? LEVELS.WATCH : LEVELS.NORMAL);
    breadthInfo = { date: w.date, breadth: w.breadth, alarmLevel: breadth.alarmLevel, watchLevel: watchAt, baseline: m ?? null, level: st, funds: breadth.funds ?? null, staleDays: Math.round(stale) };
    raise(st);
    const p = { b: w.breadth, alarm: breadth.alarmLevel, mean: m };
    if (st === LEVELS.ALARM) items.push({ k: 'breadthAlarm', p }); else if (st === LEVELS.WATCH) items.push({ k: 'breadthWatch', p });
    if (stale > 14) items.push({ k: 'stale', p: { days: Math.round(stale) } });
  }
  let fxInfo = null;
  if (fx?.flags) {
    const last = fx.recent?.length ? fx.recent[fx.recent.length - 1].date : null;
    const recent = last ? fx.flags.filter((f) => (Date.parse(`${last}T00:00:00Z`) - Date.parse(`${f.date}T00:00:00Z`)) / DAY <= FX_RECENT_DAYS) : [];
    fxInfo = { series: fx.series, lastDate: last, recentShocks: recent, level: recent.length ? LEVELS.ALARM : LEVELS.NORMAL };
    raise(fxInfo.level);
    for (const f of recent) items.push({ k: 'fxShock', p: { date: f.date, move: f.move, z: f.z } });
  }
  if (!breadthInfo && !fxInfo) items.push({ k: 'noData' });
  if (level === LEVELS.NORMAL && (breadthInfo || fxInfo)) items.unshift({ k: 'allNormal' });
  return { level, levelTr: LEVEL_TR[level], items, drivers: items.map((i) => driverText(i, 'tr')), breadth: breadthInfo, fx: fxInfo };
}

/** Stable short document id: same inputs give the same id, so a printed copy can be matched to the stored evidence. */
export function reportId(assessment, meta) { return createHash('sha256').update(JSON.stringify({ a: assessment, d: meta?.dataAsOf ?? null, g: meta?.generatedAt ?? null })).digest('hex').slice(0, 12).toUpperCase(); }
