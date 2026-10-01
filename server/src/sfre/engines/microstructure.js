import { makeResult, failed, STATUS, CALIBRATION, coverageOf } from '../core/result.js';
import { ols, median, robustScale, finite, mean, sum } from '../core/stats.js';

const ENGINE = 'microstructure';
export const EWMA_LAMBDA = 0.94; // RiskMetrics convention -- UNCALIBRATED
export const MIN_OBS = 20;

/** Market-model abnormal returns. Estimation window ends `gap` bars before the evaluation start (no contamination). */
export function abnormalReturns({ assetReturns, marketReturns, evalFrom, evalTo, estimationLength = 120, gap = 1 }) {
  const params = { estimationLength, gap, evalFrom, evalTo };
  if (!Array.isArray(assetReturns) || assetReturns.length !== marketReturns?.length) return failed(ENGINE, 'M01.abnormal_return', 'asset/market return arrays must be equal length', { parameters: params });
  if (!(evalFrom >= gap + 1) || evalTo > assetReturns.length || evalTo <= evalFrom) return failed(ENGINE, 'M01.abnormal_return', 'invalid window', { parameters: params });
  const e1 = evalFrom - gap; const e0 = Math.max(0, e1 - estimationLength);
  const xs = []; const ys = [];
  for (let i = e0; i < e1; i++) if (finite(assetReturns[i]) && finite(marketReturns[i])) { xs.push(marketReturns[i]); ys.push(assetReturns[i]); }
  if (xs.length < MIN_OBS) return makeResult({ engine: ENGINE, modelId: 'M01.abnormal_return', status: STATUS.INSUFFICIENT_DATA, coverage: coverageOf(xs.length, estimationLength), parameters: params, notes: [`estimation window has ${xs.length} valid pairs < ${MIN_OBS}`] });
  const fit = ols(xs, ys);
  if (!fit) return failed(ENGINE, 'M01.abnormal_return', 'market return has zero variance in estimation window', { parameters: params });
  const ar = [];
  const unobserved = [];
  for (let i = evalFrom; i < evalTo; i++) {
    if (finite(assetReturns[i]) && finite(marketReturns[i])) ar.push({ index: i, ar: assetReturns[i] - (fit.a + fit.b * marketReturns[i]), z: (assetReturns[i] - (fit.a + fit.b * marketReturns[i])) / fit.residualStd });
    else { ar.push({ index: i, ar: null, z: null }); unobserved.push(`return[${i}]`); }
  }
  return makeResult({
    engine: ENGINE, modelId: 'M01.abnormal_return', status: STATUS.MEASURED,
    value: { alpha: fit.a, beta: fit.b, n: fit.n, r2: fit.r2, residualStd: fit.residualStd, abnormal: ar, car: sum(ar.filter((x) => x.ar !== null).map((x) => x.ar)) },
    uncertainty: { betaStdErr: fit.seB, residualStd: fit.residualStd },
    coverage: coverageOf(ar.length - unobserved.length, ar.length), unobserved,
    calibration: CALIBRATION.ESTIMATED, parameters: params,
  });
}

/** Abnormal volume as robust z of eval volumes against the reference window. */
export function abnormalVolume({ volumeRef, volumeEval }) {
  const ref = (volumeRef || []).filter(finite);
  if (ref.length < MIN_OBS) return makeResult({ engine: ENGINE, modelId: 'M01.abnormal_volume', status: STATUS.INSUFFICIENT_DATA, coverage: coverageOf(ref.length, MIN_OBS), parameters: {} });
  const scale = robustScale(ref);
  if (!(scale > 0)) return makeResult({ engine: ENGINE, modelId: 'M01.abnormal_volume', status: STATUS.MODEL_UNCERTAIN, parameters: {}, notes: ['reference volume has zero spread'] });
  const med = median(ref);
  const unobserved = [];
  const av = (volumeEval || []).map((v, i) => { if (!finite(v)) { unobserved.push(`volume[${i}]`); return null; } return (v - med) / scale; });
  return makeResult({ engine: ENGINE, modelId: 'M01.abnormal_volume', status: STATUS.MEASURED, value: { median: med, scale, av }, coverage: coverageOf(av.length - unobserved.length, av.length), unobserved, calibration: CALIBRATION.ESTIMATED, parameters: {} });
}

/** Amihud (2002) illiquidity = mean(|r| / (P*V)), days with zero/missing dollar volume excluded and counted. */
export function amihud({ returns, prices, volumes }) {
  const n = returns.length;
  const vals = []; let excluded = 0;
  for (let i = 0; i < n; i++) {
    const dv = prices[i + 1] * volumes[i + 1]; // returns[i] belongs to bar i+1
    if (finite(returns[i]) && finite(dv) && dv > 0) vals.push(Math.abs(returns[i]) / dv); else excluded++;
  }
  const params = { definition: 'mean(|r|/(P*V))' };
  if (vals.length < MIN_OBS) return makeResult({ engine: ENGINE, modelId: 'M01.amihud', status: STATUS.INSUFFICIENT_DATA, coverage: coverageOf(vals.length, n), parameters: params, notes: [`${excluded} days excluded (zero/missing dollar volume)`] });
  return makeResult({ engine: ENGINE, modelId: 'M01.amihud', status: STATUS.MEASURED, value: { illiq: mean(vals), n: vals.length, excludedDays: excluded }, coverage: coverageOf(vals.length, n), calibration: CALIBRATION.ESTIMATED, parameters: params });
}

export function realizedVol(returns) {
  const r = returns.filter(finite);
  return { value: Math.sqrt(sum(r.map((x) => x * x))), n: r.length };
}

/** EWMA variance recursion; seeded with the sample variance of the first `seed` returns. */
export function ewmaVol(returns, lambda = EWMA_LAMBDA, seed = 20) {
  const r = returns.filter(finite);
  if (r.length <= seed) return null;
  let s2 = mean(r.slice(0, seed).map((x) => x * x));
  const path = [];
  for (let i = seed; i < r.length; i++) { s2 = lambda * s2 + (1 - lambda) * r[i] * r[i]; path.push(Math.sqrt(s2)); }
  return { path, last: path[path.length - 1], lambda };
}
