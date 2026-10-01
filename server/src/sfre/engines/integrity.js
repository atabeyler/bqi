import { makeResult, STATUS, CALIBRATION, coverageOf } from '../core/result.js';
import { finite, median, robustScale } from '../core/stats.js';

const ENGINE = 'integrity';
export const Z = 3.5;
export const STAGES = Object.freeze(['ACCUMULATION', 'PRICE_ACCELERATION', 'VOLUME_EXPANSION', 'ATTENTION_SURGE', 'DISTRIBUTION', 'COLLAPSE']);
export const MIN_REF = 120;
export const MIN_CHAIN_FOR_SIGNAL = 4;
const DISCLAIMER = 'Pattern similarity only. This is not an allegation or finding of manipulation by any person or company.';

const zOf = (x, ref) => { const s = robustScale(ref); return s > 0 ? (x - median(ref)) / s : null; };
function rollingSums(a, w) { const out = []; for (let i = w; i <= a.length; i++) { let s = 0; for (let j = i - w; j < i; j++) s += a[j]; out.push(s); } return out; }
function maxDrawdown(p) { let peak = -Infinity; let dd = 0; for (const x of p) { peak = Math.max(peak, x); dd = Math.max(dd, 1 - x / peak); } return dd; }

/**
 * Pump-and-dump pattern similarity (staged, ordered) over an evaluation window.
 * ref: {price[], volume[], attention[]|null} preceding the window; win: same fields over the evaluation window.
 */
export function pumpDumpPattern({ ref, win }) {
  const params = { Z, minRef: MIN_REF, minChainForSignal: MIN_CHAIN_FOR_SIGNAL, stages: STAGES };
  const refP = ref.price || []; const refV = ref.volume || [];
  if (refP.length < MIN_REF || refV.length < MIN_REF || (win.price || []).length < 5) return makeResult({ engine: ENGINE, modelId: 'M50.pump_dump_pattern', status: STATUS.INSUFFICIENT_DATA, coverage: coverageOf(Math.min(refP.length, refV.length), MIN_REF), parameters: params, notes: [DISCLAIMER] });
  const refR = refP.slice(1).map((p, i) => Math.log(p / refP[i])).filter(finite);
  const winP = win.price; const winR = winP.slice(1).map((p, i) => Math.log(p / winP[i]));
  const n = winR.length;
  const zV = (win.volume || []).slice(1).map((v) => (finite(v) ? zOf(v, refV) : null));
  const zA = win.attention && ref.attention ? win.attention.slice(1).map((a) => (finite(a) ? zOf(a, ref.attention) : null)) : null;
  const w3 = 3; const ref3 = rollingSums(refR, w3);
  const first = (pred) => { for (let t = 0; t < n; t++) if (pred(t)) return t; return -1; };
  const stages = {};
  const zR = winR.map((r) => zOf(r, refR));
  stages.ACCUMULATION = zV.length ? { time: first((t) => zV[t] !== null && zV[t] > Z && zR[t] !== null && zR[t] < Z) } : null;
  stages.PRICE_ACCELERATION = { time: first((t) => { if (t < w3 - 1) return zR[t] !== null && zR[t] > Z; const s = winR[t] + winR[t - 1] + winR[t - 2]; const z = zOf(s, ref3); return (z !== null && z > Z) || (zR[t] !== null && zR[t] > Z); }) };
  stages.VOLUME_EXPANSION = zV.length ? { time: first((t) => zV[t] !== null && zV[t] > Z) } : null;
  stages.ATTENTION_SURGE = zA ? { time: first((t) => zA[t] !== null && zA[t] > Z) } : null;
  // peak of the window price path
  let peakIdx = 0; for (let i = 1; i < winP.length; i++) if (winP[i] > winP[peakIdx]) peakIdx = i;
  stages.DISTRIBUTION = zV.length ? { time: first((t) => t + 1 > peakIdx && zV[t] !== null && zV[t] > Z && winR[t] <= 0) } : null;
  const wlen = winP.length; const refDD = []; for (let i = wlen; i <= refP.length; i++) refDD.push(maxDrawdown(refP.slice(i - wlen, i)));
  const ddNow = maxDrawdown(winP);
  const ddz = refDD.length >= 20 ? zOf(ddNow, refDD) : null;
  let troughIdx = peakIdx; for (let i = peakIdx; i < winP.length; i++) if (winP[i] < winP[troughIdx] || troughIdx === peakIdx) troughIdx = winP[i] <= winP[troughIdx] ? i : troughIdx;
  stages.COLLAPSE = ddz === null ? null : { time: ddz > Z ? Math.max(0, troughIdx - 1) : -1, ddZ: ddz };
  const unobserved = []; const rows = [];
  for (const name of STAGES) {
    const st = stages[name];
    if (st === null || st === undefined) { unobserved.push(`stage.${name}`); rows.push({ stage: name, observable: false, active: null, time: null }); continue; }
    rows.push({ stage: name, observable: true, active: st.time >= 0, time: st.time >= 0 ? st.time : null, ...(st.ddZ !== undefined ? { drawdownZ: st.ddZ } : {}) });
  }
  // longest chain of active stages with non-decreasing times in canonical order
  const act = rows.filter((r) => r.active);
  const dp = act.map(() => 1);
  for (let i = 0; i < act.length; i++) for (let j = 0; j < i; j++) if (act[j].time <= act[i].time) dp[i] = Math.max(dp[i], dp[j] + 1);
  const chain = dp.length ? Math.max(...dp) : 0;
  const observable = rows.filter((r) => r.observable).length;
  const similarity = observable ? chain / observable : null;
  const hasPriceAndExit = rows.find((r) => r.stage === 'PRICE_ACCELERATION')?.active && (rows.find((r) => r.stage === 'COLLAPSE')?.active || rows.find((r) => r.stage === 'DISTRIBUTION')?.active);
  const signal = chain >= MIN_CHAIN_FOR_SIGNAL && hasPriceAndExit;
  return makeResult({
    engine: ENGINE, modelId: 'M50.pump_dump_pattern', status: signal ? STATUS.SIGNAL : STATUS.NO_SIGNAL,
    value: { kind: signal ? 'MARKET_INTEGRITY_ANOMALY' : 'PATTERN_SIMILARITY', patternSimilarity: similarity, orderedChain: chain, observableStages: observable, stages: rows, disclaimer: DISCLAIMER },
    coverage: coverageOf(observable, STAGES.length), unobserved, calibration: CALIBRATION.UNCALIBRATED, parameters: params,
    notes: [DISCLAIMER, 'NO_SIGNAL is not evidence of integrity'],
  });
}
