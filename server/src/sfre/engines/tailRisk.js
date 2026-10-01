import { makeResult, failed, STATUS, CALIBRATION, coverageOf } from '../core/result.js';
import { covMatrix, cholesky, quantile, mean } from '../core/stats.js';
import { priceImpact } from './impact.js';
import { hashOf } from '../core/canonical.js';

const ENGINE = 'tailRisk';
export const MIN_TAIL_OBS = 60;

function blockLength(n) { return Math.max(1, Math.ceil(Math.cbrt(n))); }

/** scenario matrix [N][K] of horizon log-returns */
export function generateScenarios(method, returns, N, rng, horizon = 1) {
  const T = returns.length; const K = returns[0].length;
  const out = [];
  if (method === 'bootstrap') {
    const b = blockLength(T);
    for (let s = 0; s < N; s++) {
      const acc = new Array(K).fill(0); let got = 0;
      while (got < horizon) {
        const start = rng.int(Math.max(1, T - b + 1));
        for (let j = 0; j < b && got < horizon; j++, got++) for (let k = 0; k < K; k++) acc[k] += returns[start + j][k];
      }
      out.push(acc);
    }
  } else {
    const L = cholesky(covMatrix(returns));
    if (!L) return null;
    const mu = Array.from({ length: K }, (_, k) => mean(returns.map((r) => r[k])));
    const sh = Math.sqrt(horizon);
    for (let s = 0; s < N; s++) {
      const z = Array.from({ length: K }, () => rng.normal());
      out.push(mu.map((m, k) => { let v = 0; for (let j = 0; j <= k; j++) v += L[k][j] * z[j]; return m * horizon + sh * v; }));
    }
  }
  return out;
}

/** exposures: [F][K] TRY; returns scenario PnL [N][F] */
function pnl(scen, exposures) {
  return scen.map((r) => exposures.map((row) => { let p = 0; for (let k = 0; k < row.length; k++) p += row[k] * (Math.exp(r[k]) - 1); return p; }));
}

function esStats(losses, alpha) {
  const N = losses.length; const m = Math.max(1, Math.ceil((1 - alpha) * N - 1e-9)); // tolerance: (1-0.975)*200 is 5.000000000000004 in floating point
  const idx = losses.map((l, i) => [l, i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).slice(0, m);
  return { VaR: idx[m - 1][0], ES: mean(idx.map((x) => x[0])), tailIdx: idx.map((x) => x[1]), m };
}

/**
 * returns: [T][K] historical asset log-returns (strictly PIT-prior). exposures: [F][K] TRY value per fund/asset.
 * Reports bootstrap and Gaussian side by side; disagreement = non-overlapping MC intervals.
 */
export function tailRisk({ returns, exposures, fundIds, rng, N = 10000, alpha = 0.975, horizon = 1, assets = null, impact = null, B = 200 }) {
  const params = { N, alpha, horizon, B, methods: ['bootstrap', 'gaussian'], blockLength: returns?.length ? blockLength(returns.length) : null };
  if (!returns?.length || returns.length < MIN_TAIL_OBS) return makeResult({ engine: ENGINE, modelId: 'M11.tail', status: STATUS.INSUFFICIENT_DATA, coverage: coverageOf(returns?.length || 0, MIN_TAIL_OBS), parameters: params });
  if (returns.some((r) => r.some((x) => !Number.isFinite(x)))) return failed(ENGINE, 'M11.tail', 'non-finite returns (missing data must be handled upstream, not zero-filled)', { parameters: params });
  const methodsOut = {};
  const notes = [];
  for (const method of ['bootstrap', 'gaussian']) {
    const scen = generateScenarios(method, returns, N, rng.child(method), horizon);
    if (!scen) { methodsOut[method] = { status: STATUS.MODEL_UNCERTAIN, note: 'covariance not positive definite' }; continue; }
    const P = pnl(scen, exposures);
    const loss = P.map((row) => -row.reduce((s, x) => s + x, 0));
    const sys = esStats(loss, alpha);
    // MC interval for system ES by resampling scenarios
    const r2 = rng.child(`${method}-ci`); const ess = [];
    for (let b = 0; b < B; b++) { const sample = new Array(N); for (let i = 0; i < N; i++) sample[i] = loss[r2.int(N)]; ess.push(esStats(sample, alpha).ES); }
    const fundOut = fundIds.map((id, f) => {
      const fl = P.map((row) => -row[f]);
      const e = esStats(fl, alpha);
      const component = mean(sys.tailIdx.map((i) => fl[i])); // Euler / component ES wrt system tail
      return { id, VaR: e.VaR, ES: e.ES, componentES: component };
    });
    methodsOut[method] = {
      systemVaR: sys.VaR, systemES: sys.ES, esInterval: { lo: quantile(ess, 0.025), hi: quantile(ess, 0.975) },
      funds: fundOut, sumComponentES: fundOut.reduce((s, x) => s + x.componentES, 0), tailCount: sys.m,
    };
  }
  // liquidity-adjusted loss: ES + sum_k V_ik * 0.5 * d_k(V_ik)
  let lalUnobserved = [];
  if (assets && impact) {
    for (const m of Object.values(methodsOut)) {
      if (!m.funds) continue;
      m.funds.forEach((fo, f) => {
        let cost = 0; let missing = false;
        exposures[f].forEach((V, k) => { if (V > 0) { const d = priceImpact(impact, assets[k], V); if (d === null) missing = true; else cost += V * 0.5 * d; } });
        fo.liquidationCost = missing ? null : cost;
        fo.liquidityAdjustedLoss = missing ? null : fo.ES + cost;
        if (missing) lalUnobserved.push(`impact_inputs:${fo.id}`);
      });
    }
    lalUnobserved = [...new Set(lalUnobserved)];
  } else notes.push('liquidity-adjusted loss not computed: impact model/asset liquidity inputs not supplied (UNOBSERVED)');
  const b = methodsOut.bootstrap; const g = methodsOut.gaussian;
  let disagreement = null;
  if (b?.esInterval && g?.esInterval) disagreement = b.esInterval.hi < g.esInterval.lo || g.esInterval.hi < b.esInterval.lo;
  const status = !b?.esInterval || !g?.esInterval ? STATUS.MODEL_UNCERTAIN : disagreement ? STATUS.MODEL_DISAGREEMENT : STATUS.UNCALIBRATED;
  if (disagreement) notes.push('bootstrap and Gaussian ES intervals do not overlap: both reported, none preferred');
  return makeResult({
    engine: ENGINE, modelId: 'M11.tail', status, value: { methods: methodsOut, disagreement },
    uncertainty: { mcIntervals: { bootstrap: b?.esInterval ?? null, gaussian: g?.esInterval ?? null } },
    coverage: coverageOf(returns.length, returns.length), unobserved: lalUnobserved, calibration: CALIBRATION.UNCALIBRATED,
    parameters: params, inputHashes: [hashOf(returns.length), hashOf(exposures)], notes: [...notes, 'ES from historical sample / Gaussian fit; no out-of-sample backtest performed (UNCALIBRATED)'],
  });
}
