import { makeResult, failed, STATUS, CALIBRATION, coverageOf } from '../../core/result.js';
import { sha256, canonicalJson } from '../../core/canonical.js';
import { parseTime } from '../../data/observation.js';
import { validateEvents, indexEvents, LIMITS_SURV, DISCLAIMER, groupBy } from './events.js';
import { PARAMS, MODELS, detectSpoofing, detectLayering, detectWash, detectMarkingClose, detectBookAnomalies, detectCrossVenue, detectCoordinatedTrading } from './detectors.js';

const ENGINE = 'surveillance';
export const DETECTOR_NAMES = Object.freeze(['spoofing', 'layering', 'wash', 'close', 'book', 'cross', 'coordination']);
export const SUMMARY_MODEL = 'M70.surveillance_summary';
const hashEvents = (ev) => sha256(ev.map((e) => canonicalJson(e)).join('\n'));

export function validateSurveillance(s) {
  if (!s || typeof s !== 'object') return 'surveillance section required';
  if (Number.isNaN(parseTime(s.asOf))) return 'surveillance.asOf required (ISO-8601 UTC): point-in-time boundary of the message stream';
  const e1 = validateEvents(s.referenceEvents ?? [], { label: 'referenceEvents' }) || validateEvents(s.events ?? [], { label: 'events' });
  if (e1) return e1;
  if ((s.events?.length ?? 0) > LIMITS_SURV.events || (s.referenceEvents?.length ?? 0) > LIMITS_SURV.referenceEvents) return 'event stream exceeds size limits';
  if (!s.events?.length) return 'events (evaluation window) required';
  const asOf = parseTime(s.asOf);
  const late = [...(s.referenceEvents ?? []), ...s.events].find((e) => e.ts > asOf);
  if (late) return `look-ahead guard: event at ts ${late.ts} is later than asOf ${s.asOf}`;
  const refMax = (s.referenceEvents ?? []).reduce((m, e) => Math.max(m, e.ts), -Infinity); const evMin = s.events.reduce((m, e) => Math.min(m, e.ts), Infinity);
  if (refMax >= evMin) return 'reference events must strictly precede evaluation events (look-ahead guard)';
  for (const d of s.detectors ?? []) if (!DETECTOR_NAMES.includes(d)) return `detectors must be a subset of ${DETECTOR_NAMES.join(',')}`;
  for (const l of s.instrumentLinks ?? []) if (!l.a || !l.b) return 'instrumentLinks: {a,b} required';
  for (const sess of s.sessions ?? []) if (!sess.day || !Number.isFinite(sess.openTs) || !Number.isFinite(sess.closeTs) || sess.closeTs <= sess.openTs) return 'sessions: {day, openTs, closeTs} invalid';
  const a = s.params?.alpha; if (a !== undefined && !(a > 0 && a <= 0.05)) return 'params.alpha must be in (0, 0.05]';
  for (const [k, v] of Object.entries(s.params ?? {})) {
    if (k === 'alpha') continue;
    if (!PARAMS[k] || typeof PARAMS[k] !== 'object') return `params.${k} is not a known detector parameter group`;
    for (const [kk, vv] of Object.entries(v ?? {})) if (!(kk in PARAMS[k]) || !(Number.isFinite(vv) && vv > 0)) return `params.${k}.${kk} must be a known parameter with a positive finite value`;
  }
  return null;
}

/** M70 Market Surveillance 2.0: seven pattern detectors + summary, strictly point-in-time. Pattern similarity, never an allegation. */
export function runSurveillance(s, { seed = 1, prior = [] } = {}) {
  const err = validateSurveillance(s);
  if (err) return [failed(ENGINE, 'M70.surveillance', err)];
  const P = { ...PARAMS, alpha: s.params?.alpha ?? PARAMS.alpha };
  for (const k of ['spoof', 'layer', 'wash', 'close', 'book', 'cross', 'coord']) if (s.params?.[k]) P[k] = { ...PARAMS[k], ...s.params[k] };
  const salt = s.salt ?? 'sfre'; const want = s.detectors?.length ? s.detectors : DETECTOR_NAMES;
  const ref = indexEvents(s.referenceEvents ?? []); const ev = indexEvents(s.events);
  const evStart = Math.min(...s.events.map((e) => e.ts));
  const sessions = s.sessions ?? []; const split = (list) => list.map((sess) => ({ day: sess.day, closeTs: sess.closeTs, trades: [...ref.trades, ...ev.trades].filter((t) => t.ts >= sess.openTs && t.ts <= sess.closeTs + 1) }));
  const refSess = sessions.filter((x) => x.closeTs < evStart); const evSess = sessions.filter((x) => x.closeTs >= evStart);
  const dayCancel = (sess) => { const os = [...ref.orders, ...ev.orders].filter((o) => o.ts >= sess.openTs && o.ts <= sess.closeTs); return os.length ? os.filter((o) => o.cancelTs !== null).length / os.length : null; };
  const dailySeries = { reference: refSess.map(dayCancel).filter((x) => x !== null), evaluation: evSess.map(dayCancel).filter((x) => x !== null) };
  const ctx = { salt, seed, ownerGroups: s.ownerGroups, instrumentLinks: s.instrumentLinks, dailySeries };
  const run = { spoofing: () => detectSpoofing(ref, ev, P, ctx), layering: () => detectLayering(ref, ev, P, ctx), wash: () => detectWash(ev, P, ctx), close: () => detectMarkingClose(split(refSess), split(evSess), P, ctx), book: () => detectBookAnomalies(ref, ev, P, ctx), cross: () => detectCrossVenue(ref, ev, P, ctx), coordination: () => detectCoordinatedTrading(ev, P, ctx) };
  const inputHash = hashEvents(s.events); const refHash = hashEvents(s.referenceEvents ?? []);
  const results = [];
  for (const name of want) {
    let d; try { d = run[name](); } catch (e) { results.push(failed(ENGINE, MODELS[name], e?.message || String(e))); continue; }
    const unobserved = d.unobserved ?? [];
    const status = d.status === 'SIGNAL' ? STATUS.SIGNAL : d.status === 'NO_SIGNAL' ? STATUS.NO_SIGNAL : STATUS.INSUFFICIENT_DATA;
    results.push(makeResult({
      engine: ENGINE, modelId: d.model, status,
      value: status === STATUS.INSUFFICIENT_DATA ? null : { kind: 'MARKET_SURVEILLANCE_PATTERN', label: d.label, findings: d.findings, stats: d.stats, disclaimer: DISCLAIMER },
      coverage: coverageOf(status === STATUS.INSUFFICIENT_DATA ? 0 : 1, 1), unobserved, calibration: CALIBRATION.UNCALIBRATED,
      parameters: { asOf: s.asOf, alpha: P.alpha, detector: name, thresholds: P[name === 'spoofing' ? 'spoof' : name === 'layering' ? 'layer' : name === 'wash' ? 'wash' : name === 'close' ? 'close' : name === 'book' ? 'book' : name === 'cross' ? 'cross' : 'coord'], multipleTesting: 'Bonferroni over tested groups', seed },
      inputHashes: [inputHash, refHash], notes: [DISCLAIMER, 'NO_SIGNAL is not evidence of compliance; thresholds are UNCALIBRATED', ...(status === STATUS.INSUFFICIENT_DATA ? [String(d.stats?.reason ?? '')] : [])],
    }));
  }
  const bySt = groupBy(results, (r) => r.status);
  const corro = prior.filter((r) => ['integrity', 'coordination', 'anomaly', 'attention'].includes(r.engine)).map((r) => ({ engine: r.engine, model_id: r.model_id, status: r.status, result_hash: r.result_hash }));
  results.push(makeResult({
    engine: ENGINE, modelId: SUMMARY_MODEL, status: STATUS.MEASURED,
    value: { signals: (bySt.get(STATUS.SIGNAL) || []).map((r) => ({ model_id: r.model_id, label: r.value.label, findings: r.value.findings.length })), detectorsRun: results.length, insufficient: (bySt.get(STATUS.INSUFFICIENT_DATA) || []).map((r) => r.model_id), corroboration: corro, disclaimer: DISCLAIMER },
    coverage: coverageOf(results.filter((r) => r.status !== STATUS.INSUFFICIENT_DATA).length, results.length), calibration: CALIBRATION.UNCALIBRATED, parameters: { detectors: want },
    inputHashes: results.map((r) => r.result_hash), notes: [DISCLAIMER, 'corroboration lists existing M50/M51/M52/M20 results of the same run; agreement is not independent confirmation'],
  }));
  return results;
}
