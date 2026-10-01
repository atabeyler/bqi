import { makeResult, failed, STATUS, CALIBRATION, coverageOf } from '../core/result.js';
import { sum } from '../core/stats.js';

const ENGINE = 'concentration';
const TOL = 1e-9;

/**
 * weights: [{id, w}] fractions of NAV (w may be null = unobserved).
 * Unobserved weights are NOT zero: the observed mass s<1 leaves remainder rho; HHI is bounded
 * HHI in [sum w^2, sum w^2 + rho^2].
 */
export function hhi(weights, { entity = null } = {}) {
  const obs = weights.filter((x) => x.w !== null && x.w !== undefined);
  const unobserved = weights.filter((x) => x.w === null || x.w === undefined).map((x) => `weight:${x.id}`);
  if (obs.some((x) => !(Number.isFinite(x.w)) || x.w < 0)) return failed(ENGINE, 'M02.hhi', 'weights must be finite and non-negative');
  const s = sum(obs.map((x) => x.w));
  if (s > 1 + 1e-9) return failed(ENGINE, 'M02.hhi', `weights sum to ${s} > 1`);
  const sq = sum(obs.map((x) => x.w * x.w));
  const rho = Math.max(0, 1 - s);
  const sorted = obs.map((x) => x.w).sort((a, b) => b - a);
  const topK = (k) => sum(sorted.slice(0, k));
  const full = rho <= TOL && unobserved.length === 0;
  const value = full
    ? { hhi: sq, nEff: sq > 0 ? 1 / sq : null, top1: topK(1), top3: topK(3), top5: topK(5), remainder: 0 }
    : { hhiLowerBound: sq, hhiUpperBound: sq + rho * rho, nEffLowerBound: 1 / (sq + rho * rho), remainder: rho, top1AtLeast: topK(1), top3AtLeast: topK(3), top5AtLeast: topK(5) };
  return makeResult({
    engine: ENGINE, modelId: 'M02.hhi', status: full ? STATUS.MEASURED : STATUS.INSUFFICIENT_OBSERVABILITY,
    value, coverage: coverageOf(Math.min(1, s) , 1), unobserved, calibration: CALIBRATION.UNCALIBRATED,
    parameters: entity ? { entity } : {}, notes: full ? [] : ['observed holdings do not cover the whole portfolio: HHI reported as an interval, not a point'],
  });
}

/** Free-float exposure = fund shares / free-float shares; unobserved free float stays unobserved. */
export function freeFloatExposure(holdings) {
  const rows = holdings.map((h) => ({
    asset: h.asset,
    exposure: Number.isFinite(h.freeFloatShares) && h.freeFloatShares > 0 ? h.shares / h.freeFloatShares : null,
  }));
  const unobserved = rows.filter((r) => r.exposure === null).map((r) => `free_float:${r.asset}`);
  return makeResult({
    engine: ENGINE, modelId: 'M02.free_float_exposure', status: unobserved.length ? STATUS.INSUFFICIENT_OBSERVABILITY : STATUS.MEASURED,
    value: rows, coverage: coverageOf(rows.length - unobserved.length, rows.length), unobserved, parameters: {},
  });
}
