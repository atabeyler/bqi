import { makeResult, STATUS, CALIBRATION, coverageOf } from '../core/result.js';
import { mean, variance, median } from '../core/stats.js';

const ENGINE = 'regime';

function normPdf(x, m, v) { return Math.exp(-0.5 * (x - m) ** 2 / v) / Math.sqrt(2 * Math.PI * v); }

/** Baum–Welch for a 2-state Gaussian HMM on returns (state 0 = low vol, 1 = high vol). Deterministic init. */
export function fitHmm(returns, { maxIter = 200, tol = 1e-8 } = {}) {
  const T = returns.length;
  const absMed = median(returns.map(Math.abs));
  const lowSet = returns.filter((x) => Math.abs(x) <= absMed); const highSet = returns.filter((x) => Math.abs(x) > absMed);
  let m = [mean(lowSet), mean(highSet)];
  let v = [Math.max(variance(lowSet), 1e-12), Math.max(variance(highSet), 1e-12)];
  let A = [[0.95, 0.05], [0.05, 0.95]]; let pi = [0.5, 0.5];
  let prevLL = -Infinity; let iterations = 0;
  for (let it = 0; it < maxIter; it++) {
    iterations = it + 1;
    const alpha = Array.from({ length: T }, () => [0, 0]); const c = new Array(T).fill(0);
    for (let t = 0; t < T; t++) {
      for (let j = 0; j < 2; j++) {
        const prior = t === 0 ? pi[j] : alpha[t - 1][0] * A[0][j] + alpha[t - 1][1] * A[1][j];
        alpha[t][j] = prior * normPdf(returns[t], m[j], v[j]);
      }
      c[t] = alpha[t][0] + alpha[t][1];
      if (!(c[t] > 0)) c[t] = 1e-300;
      alpha[t][0] /= c[t]; alpha[t][1] /= c[t];
    }
    const ll = c.reduce((s, x) => s + Math.log(x), 0);
    const beta = Array.from({ length: T }, () => [1, 1]);
    for (let t = T - 2; t >= 0; t--) {
      for (let i = 0; i < 2; i++) {
        beta[t][i] = (A[i][0] * normPdf(returns[t + 1], m[0], v[0]) * beta[t + 1][0] + A[i][1] * normPdf(returns[t + 1], m[1], v[1]) * beta[t + 1][1]) / c[t + 1];
      }
    }
    const gamma = alpha.map((a, t) => { const g0 = a[0] * beta[t][0]; const g1 = a[1] * beta[t][1]; const s = g0 + g1; return [g0 / s, g1 / s]; });
    const xi = [[0, 0], [0, 0]];
    for (let t = 0; t < T - 1; t++) {
      let tot = 0; const tmp = [[0, 0], [0, 0]];
      for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) { tmp[i][j] = alpha[t][i] * A[i][j] * normPdf(returns[t + 1], m[j], v[j]) * beta[t + 1][j]; tot += tmp[i][j]; }
      for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) xi[i][j] += tmp[i][j] / tot;
    }
    pi = [gamma[0][0], gamma[0][1]];
    for (let i = 0; i < 2; i++) { const d = xi[i][0] + xi[i][1]; A[i] = [xi[i][0] / d, xi[i][1] / d]; }
    for (let j = 0; j < 2; j++) {
      const w = gamma.reduce((s, g) => s + g[j], 0);
      m[j] = gamma.reduce((s, g, t) => s + g[j] * returns[t], 0) / w;
      v[j] = Math.max(gamma.reduce((s, g, t) => s + g[j] * (returns[t] - m[j]) ** 2, 0) / w, 1e-12);
    }
    if (Math.abs(ll - prevLL) < tol) { prevLL = ll; break; }
    prevLL = ll;
  }
  // order states: 0 = lower variance
  if (v[0] > v[1]) { m = [m[1], m[0]]; v = [v[1], v[0]]; A = [[A[1][1], A[1][0]], [A[0][1], A[0][0]]]; pi = [pi[1], pi[0]]; }
  const occupancy = [0, 0];
  return { m, v, A, pi, logLik: prevLL, iterations, occupancy };
}

/** Forward (filtered) probabilities only: P(S_t | r_1..t). Smoothing is intentionally not exposed. */
export function hmmFilter(params, returns, prior = null) {
  const out = []; let p = prior ?? params.pi;
  for (let t = 0; t < returns.length; t++) {
    const pred = t === 0 && !prior ? p : [p[0] * params.A[0][0] + p[1] * params.A[1][0], p[0] * params.A[0][1] + p[1] * params.A[1][1]];
    const a0 = pred[0] * normPdf(returns[t], params.m[0], params.v[0]); const a1 = pred[1] * normPdf(returns[t], params.m[1], params.v[1]);
    const s = a0 + a1 || 1e-300;
    p = [a0 / s, a1 / s]; out.push(p);
  }
  return out;
}

export const MIN_REGIME_OBS = 250;

export function regimeFilter({ train, evaluate }) {
  const params = { states: 2, minObs: MIN_REGIME_OBS };
  const clean = train.filter(Number.isFinite);
  if (clean.length < MIN_REGIME_OBS) return makeResult({ engine: ENGINE, modelId: 'M12.hmm', status: STATUS.INSUFFICIENT_DATA, coverage: coverageOf(clean.length, MIN_REGIME_OBS), parameters: params });
  const fit = fitHmm(clean);
  const trainFilt = hmmFilter(fit, clean);
  const occ = [0, 1].map((j) => trainFilt.reduce((s, p) => s + p[j], 0) / trainFilt.length);
  const separated = Math.sqrt(fit.v[1]) > 1.5 * Math.sqrt(fit.v[0]);
  const degenerate = !separated || occ[0] < 0.05 || occ[1] < 0.05 || !Number.isFinite(fit.logLik);
  const filtered = hmmFilter(fit, evaluate.filter(Number.isFinite), trainFilt[trainFilt.length - 1]);
  return makeResult({
    engine: ENGINE, modelId: 'M12.hmm', status: degenerate ? STATUS.MODEL_UNCERTAIN : STATUS.UNCALIBRATED,
    value: { means: fit.m, variances: fit.v, transition: fit.A, occupancy: occ, iterations: fit.iterations, logLik: fit.logLik, filteredHighVolProb: filtered.map((p) => p[1]), lastRegime: filtered.length ? (filtered[filtered.length - 1][1] > 0.5 ? 'HIGH_VOL' : 'LOW_VOL') : null },
    coverage: coverageOf(clean.length, train.length), calibration: CALIBRATION.ESTIMATED, parameters: params,
    notes: [degenerate ? 'state separation <1.5 sigma or occupancy <5%: regimes not identified' : 'filtered (causal) probabilities only', 'in-sample fit on the training window'],
  });
}
