import { runCascade } from './cascade.js';
import { makeResult, failed, STATUS, CALIBRATION } from '../core/result.js';
import { cholesky, mahalanobisSq, covMatrix } from '../core/stats.js';

const ENGINE = 'reverseStress';

/**
 * Reverse stress: min  s' Sigma^-1 s   s.t.  Psi(s) >= tau,   0 <= s <= cap
 * Heuristic (seeded multi-start + bisection along directions + local direction search).
 * Does NOT claim a global optimum: the returned shock is FEASIBLE (verified by independent re-run),
 * so its cost is an UPPER bound on the true minimum cost; no lower bound is produced.
 *
 * returns: [T][K] historical log-returns for the shockable assets (order = shockAssets) -> Sigma.
 * redemptionScale (optional): {fundId: sigma_ref} adds redemption-fraction dimensions with cost (rho/sigma_ref)^2.
 */
export function reverseStress({ system, shockAssets, returns, criterion, rng, cap = 0.8, redemptionScale = null, redemptionCap = 0.5, nStarts = 12, nLocal = 40, nBisect = 28, options = {} }) {
  const params = { criterion, cap, redemptionCap, nStarts, nLocal, nBisect, shockAssets, redemptionFunds: redemptionScale ? Object.keys(redemptionScale) : [] };
  if (!criterion || !['lossFraction', 'failedFunds'].includes(criterion.metric) || !(criterion.threshold > 0)) return failed(ENGINE, 'M13.reverse_stress', 'criterion {metric: lossFraction|failedFunds, threshold>0} required', { parameters: params });
  const K = shockAssets.length;
  let L = null; let diagFallback = false;
  if (returns && returns.length > K + 5) L = cholesky(covMatrix(returns));
  if (!L) {
    if (!returns || returns.length < 2) return makeResult({ engine: ENGINE, modelId: 'M13.reverse_stress', status: STATUS.INSUFFICIENT_DATA, parameters: params, notes: ['no return history for the plausibility metric'] });
    diagFallback = true; // diagonal (variance-only) plausibility if covariance is singular
    const C = covMatrix(returns); L = Array.from({ length: K }, (_, i) => Array.from({ length: K }, (_, j) => (i === j ? Math.sqrt(Math.max(C[i][i], 1e-18)) : 0)));
  }
  const rFunds = redemptionScale ? Object.keys(redemptionScale) : [];
  const D = K + rFunds.length;
  const psi = (x) => {
    const priceShocks = {}; shockAssets.forEach((a, i) => { priceShocks[a] = Math.min(1, x[i]); });
    const redemptions = {}; rFunds.forEach((f, j) => { redemptions[f] = { fraction: Math.min(1, x[K + j]) }; });
    const res = runCascade(system, { priceShocks, redemptions }, options);
    if (!res.value) return { v: NaN, res };
    return { v: criterion.metric === 'lossFraction' ? res.value.system.lossFractionOfNav : res.value.system.failedFunds.length, res };
  };
  const cost = (x) => mahalanobisSq(x.slice(0, K), L) + rFunds.reduce((s, f, j) => s + (x[K + j] / redemptionScale[f]) ** 2, 0);
  const caps = Array.from({ length: D }, (_, i) => (i < K ? cap : redemptionCap));
  let evals = 0;
  const scale = (u, lam) => u.map((v, i) => v * lam * caps[i]); // lam in [0,1] scales every coordinate between 0 and its cap
  const minScale = (u) => {
    evals++; if (!(psi(scale(u, 1)).v >= criterion.threshold)) return null;
    let lo = 0; let hi = 1;
    for (let i = 0; i < nBisect; i++) { const mid = (lo + hi) / 2; evals++; if (psi(scale(u, mid)).v >= criterion.threshold) hi = mid; else lo = mid; }
    return hi;
  };
  let best = null; let infeasibleStarts = 0;
  const consider = (u) => { const lam = minScale(u); if (lam === null) return null; const x = scale(u, lam); const c = cost(x); if (!best || c < best.cost) best = { u, lam, x, cost: c }; return c; };
  const rs = rng.child('reverse-stress');
  for (let s = 0; s < nStarts; s++) {
    const u = Array.from({ length: D }, () => rs.next() ** 2);
    const m = Math.max(...u) || 1; const un = u.map((v) => v / m);
    if (consider(un) === null) infeasibleStarts++;
  }
  if (!best) {
    return makeResult({ engine: ENGINE, modelId: 'M13.reverse_stress', status: STATUS.NO_SIGNAL, value: { kind: 'NO_BREAKING_SHOCK_FOUND', evaluations: evals, infeasibleStarts, globalOptimum: false }, calibration: CALIBRATION.UNCALIBRATED, parameters: params, notes: ['no breaking shock found within the cap by this heuristic: this is NOT a proof that the system is safe'] });
  }
  // local search over direction
  let step = 0.3;
  for (let it = 0; it < nLocal; it++) {
    const cand = best.u.map((v) => Math.min(1, Math.max(0, v + step * (rs.next() - 0.5) * 2)));
    const m = Math.max(...cand);
    if (!(m > 0)) continue;
    const un = cand.map((v) => v / m);
    const prev = best.cost; consider(un);
    if (best.cost >= prev) step = Math.max(0.01, step * 0.93);
  }
  const verify = psi(best.x);
  const feasible = verify.v >= criterion.threshold;
  // monotonicity check along the best ray
  let monotone = true; let last = -Infinity;
  for (let g = 0; g <= 8; g++) { const v = psi(scale(best.u, g / 8)).v; if (v < last - 1e-12) monotone = false; last = v; }
  const shock = {}; shockAssets.forEach((a, i) => { shock[a] = best.x[i]; });
  const redemption = {}; rFunds.forEach((f, j) => { redemption[f] = best.x[K + j]; });
  const notes = ['heuristic search: globalOptimum is NOT claimed; cost is an upper bound on the minimum', 'plausibility metric = Mahalanobis distance under historical covariance (UNCALIBRATED as a probability)'];
  if (diagFallback) notes.push('covariance singular: diagonal plausibility metric used');
  if (!monotone) notes.push('criterion not monotone along the best ray: bisection result may not be the smallest feasible scale');
  return makeResult({
    engine: ENGINE, modelId: 'M13.reverse_stress', status: feasible ? (monotone ? STATUS.UNCALIBRATED : STATUS.MODEL_UNCERTAIN) : STATUS.COMPUTATION_FAILED,
    value: { kind: 'FEASIBLE_BREAKING_SHOCK', shock, redemption, plausibilityCost: best.cost, criterionAchieved: verify.v, verifiedByRerun: feasible, evaluations: evals, infeasibleStarts, globalOptimum: false, certificate: 'FEASIBLE_UPPER_BOUND_ON_MINIMUM_COST', monotoneAlongRay: monotone },
    calibration: CALIBRATION.UNCALIBRATED, unobserved: verify.res.unobserved, parameters: params, notes,
  });
}
