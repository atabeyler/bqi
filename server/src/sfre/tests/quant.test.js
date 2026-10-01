import { describe, it, expect } from 'vitest';
import { tailRisk, generateScenarios } from '../engines/tailRisk.js';
import { fitHmm, hmmFilter, regimeFilter } from '../engines/regime.js';
import { reverseStress } from '../engines/reverseStress.js';
import { detectAnomalies } from '../engines/anomaly/ensemble.js';
import { conformalThreshold, robustZDetector, cusumDetector, ewmaDetector, changePointDetector, isolationForestDetector, lofDetector, embed } from '../engines/anomaly/detectors.js';
import { Rng } from '../core/prng.js';
import { runCascade } from '../engines/cascade.js';
import { randomSystem } from './helpers.js';

const gaussianReturns = (seed, T, K, sig = 0.01) => { const r = new Rng(seed); return Array.from({ length: T }, () => Array.from({ length: K }, () => sig * r.normal())); };

describe('tail risk (Monte Carlo)', () => {
  const returns = gaussianReturns(1, 500, 3); const exposures = [[1e6, 5e5, 0], [0, 5e5, 1e6]];
  it('same seed -> identical result; different seed -> different', () => {
    const a = tailRisk({ returns, exposures, fundIds: ['a', 'b'], rng: new Rng(3), N: 2000, B: 20 });
    const b = tailRisk({ returns, exposures, fundIds: ['a', 'b'], rng: new Rng(3), N: 2000, B: 20 });
    const c = tailRisk({ returns, exposures, fundIds: ['a', 'b'], rng: new Rng(4), N: 2000, B: 20 });
    expect(a.result_hash).toBe(b.result_hash); expect(a.result_hash).not.toBe(c.result_hash);
  });
  it('Gaussian ES approximates the analytic value: ES_97.5% = sigma * phi(1.96)/0.025', () => {
    const r = tailRisk({ returns: gaussianReturns(2, 2000, 1, 0.01), exposures: [[1e6]], fundIds: ['a'], rng: new Rng(1), N: 40000, alpha: 0.975, B: 20 });
    const sigma = 1e6 * 0.01; const analytic = sigma * (Math.exp(-0.5 * 1.96 ** 2) / Math.sqrt(2 * Math.PI)) / 0.025;
    expect(Math.abs(r.value.methods.gaussian.systemES - analytic) / analytic).toBeLessThan(0.06);
  });
  it('systemic contribution reconciles exactly: sum of component ES == system ES', () => {
    const r = tailRisk({ returns, exposures, fundIds: ['a', 'b'], rng: new Rng(7), N: 3000, B: 10 });
    for (const m of ['bootstrap', 'gaussian']) expect(r.value.methods[m].sumComponentES).toBeCloseTo(r.value.methods[m].systemES, 6);
  });
  it('ES >= VaR; liquidity-adjusted loss >= ES; missing liquidity inputs -> UNOBSERVED, not zero', () => {
    const assets = [{ illiq: 1e-8 }, { illiq: 1e-8 }, { illiq: 1e-8 }];
    const r = tailRisk({ returns, exposures, fundIds: ['a', 'b'], rng: new Rng(7), N: 3000, B: 10, assets, impact: { model: 'amihud-linear' } });
    const f = r.value.methods.bootstrap.funds[0]; expect(f.ES).toBeGreaterThanOrEqual(f.VaR); expect(f.liquidityAdjustedLoss).toBeGreaterThanOrEqual(f.ES);
    const r2 = tailRisk({ returns, exposures, fundIds: ['a', 'b'], rng: new Rng(7), N: 3000, B: 10, assets: [{ illiq: null }, { illiq: 1e-8 }, { illiq: 1e-8 }], impact: { model: 'amihud-linear' } });
    expect(r2.value.methods.bootstrap.funds[0].liquidityAdjustedLoss).toBeNull(); expect(r2.unobserved.length).toBeGreaterThan(0);
    expect(r.notes.join(' ')).toMatch(/UNCALIBRATED/);
  });
  it('insufficient history and non-finite returns are rejected (never zero-filled)', () => {
    expect(tailRisk({ returns: returns.slice(0, 20), exposures, fundIds: ['a', 'b'], rng: new Rng(1) }).status).toBe('INSUFFICIENT_DATA');
    const bad = returns.map((r) => r.slice()); bad[10][1] = NaN;
    expect(tailRisk({ returns: bad, exposures, fundIds: ['a', 'b'], rng: new Rng(1) }).status).toBe('COMPUTATION_FAILED');
  });
  it('bootstrap scenario horizon sums daily returns in blocks', () => {
    const s = generateScenarios('bootstrap', returns, 10, new Rng(1), 5);
    expect(s).toHaveLength(10); expect(s[0]).toHaveLength(3);
  });
});

describe('regime HMM', () => {
  const mk = (seed) => { const r = new Rng(seed); const x = []; let s = 0; for (let t = 0; t < 1200; t++) { if (r.next() < (s === 0 ? 0.02 : 0.05)) s = 1 - s; x.push((s ? 0.03 : 0.007) * r.normal()); } return x; };
  it('recovers two volatility states', () => {
    const fit = fitHmm(mk(1));
    expect(Math.sqrt(fit.v[0])).toBeGreaterThan(0.005); expect(Math.sqrt(fit.v[0])).toBeLessThan(0.01); expect(Math.sqrt(fit.v[1])).toBeGreaterThan(0.022); expect(Math.sqrt(fit.v[1])).toBeLessThan(0.04);
  });
  it('PROPERTY (look-ahead): filtered probabilities at t never depend on returns after t', () => {
    const x = mk(2); const fit = fitHmm(x.slice(0, 800));
    const a = hmmFilter(fit, x.slice(800, 900)); const modified = x.slice(800, 900).concat([5, -5, 5]); // different future
    const b = hmmFilter(fit, modified);
    for (let i = 0; i < 100; i++) expect(b[i]).toEqual(a[i]);
  });
  it('degenerate / short training windows are flagged, not trusted', () => {
    expect(regimeFilter({ train: mk(3).slice(0, 100), evaluate: [0.01] }).status).toBe('INSUFFICIENT_DATA');
    const r = new Rng(4); const iid = Array.from({ length: 800 }, () => 0.01 * r.normal());
    const res = regimeFilter({ train: iid, evaluate: [0.01, 0.02] });
    expect(['MODEL_UNCERTAIN', 'UNCALIBRATED']).toContain(res.status); expect(res.calibration).toBe('ESTIMATED');
  });
});

describe('reverse stress', () => {
  const system = randomSystem(12, { nFunds: 5, nAssets: 5, withClaims: false });
  const shockAssets = ['A0', 'A1', 'A2', 'A3', 'A4']; const returns = gaussianReturns(5, 300, 5, 0.02);
  const criterion = { metric: 'lossFraction', threshold: 0.2 };
  it('finds a verified feasible shock and never claims global optimality', () => {
    const r = reverseStress({ system, shockAssets, returns, criterion, rng: new Rng(1), nStarts: 6, nLocal: 10, nBisect: 14 });
    expect(r.value.kind).toBe('FEASIBLE_BREAKING_SHOCK'); expect(r.value.globalOptimum).toBe(false); expect(r.value.certificate).toBe('FEASIBLE_UPPER_BOUND_ON_MINIMUM_COST');
    expect(r.value.verifiedByRerun).toBe(true);
    const check = runCascade(system, { priceShocks: r.value.shock });
    expect(check.value.system.lossFractionOfNav).toBeGreaterThanOrEqual(0.2 - 1e-9);
  });
  it('is seed-deterministic and better-than-random-start (local search never worsens the cost)', () => {
    const a = reverseStress({ system, shockAssets, returns, criterion, rng: new Rng(2), nStarts: 4, nLocal: 8, nBisect: 12 });
    const b = reverseStress({ system, shockAssets, returns, criterion, rng: new Rng(2), nStarts: 4, nLocal: 8, nBisect: 12 });
    const noLocal = reverseStress({ system, shockAssets, returns, criterion, rng: new Rng(2), nStarts: 4, nLocal: 0, nBisect: 12 });
    expect(a.result_hash).toBe(b.result_hash); expect(a.value.plausibilityCost).toBeLessThanOrEqual(noLocal.value.plausibilityCost + 1e-12);
  });
  it('unreachable criterion -> NO_BREAKING_SHOCK_FOUND with an explicit "not a proof of safety" note', () => {
    const r = reverseStress({ system, shockAssets, returns, criterion: { metric: 'lossFraction', threshold: 5 }, rng: new Rng(1), nStarts: 3, nLocal: 2, nBisect: 8 });
    expect(r.value.kind).toBe('NO_BREAKING_SHOCK_FOUND'); expect(r.status).toBe('NO_SIGNAL'); expect(r.notes.join(' ')).toMatch(/NOT a proof/);
  });
  it('invalid criterion / missing history are rejected', () => {
    expect(reverseStress({ system, shockAssets, returns, criterion: { metric: 'x', threshold: 1 }, rng: new Rng(1) }).status).toBe('COMPUTATION_FAILED');
    expect(reverseStress({ system, shockAssets, returns: [], criterion, rng: new Rng(1) }).status).toBe('INSUFFICIENT_DATA');
  });
  it('supports redemption dimensions with caller-supplied plausibility scale', () => {
    const r = reverseStress({ system, shockAssets, returns, criterion, rng: new Rng(3), nStarts: 4, nLocal: 4, nBisect: 10, redemptionScale: { F0: 0.1, F1: 0.1 } });
    expect(Object.keys(r.value.redemption)).toEqual(['F0', 'F1']);
  });
});

describe('anomaly ensemble', () => {
  const rng = new Rng(7); const ref = Array.from({ length: 200 }, () => rng.normal());
  it('every detector flags a strong level shift; consensus is unanimous', () => {
    const r = detectAnomalies({ reference: ref, evaluation: [6, 6.5, 7, 6.2, 6.8, 7.1], seed: 1 });
    expect([...r.value.signalingModels].sort()).toEqual(['change_point', 'cusum', 'ewma', 'isolation_forest', 'lof', 'robust_z'].sort()); expect(r.status).toBe('SIGNAL'); expect(r.value.consensus).toBe(1);
  });
  it('disagreement is reported, never averaged away', () => {
    const r = detectAnomalies({ reference: ref, evaluation: [0.1, 8, 0.2, -0.1, 0.3], seed: 3 }); // single spike: point detectors fire, level-shift detectors do not
    expect(r.status).toBe('MODEL_DISAGREEMENT'); expect(r.value.signalingModels).toContain('robust_z'); expect(r.value.quietModels).toContain('change_point');
    expect(r.value.disagreement).toBeGreaterThan(0); expect(r.notes.join(' ')).toMatch(/no averaging/);
  });
  it('NO_SIGNAL is not LOW_RISK, and coverage < 50% -> INSUFFICIENT_DATA', () => {
    const q = detectAnomalies({ reference: ref, evaluation: [0, 0.1, -0.1], seed: 1 });
    expect(q.status).not.toBe('LOW_RISK'); expect(q.calibration).toBe('UNCALIBRATED');
    const short = detectAnomalies({ reference: ref.slice(0, 10), evaluation: [9], seed: 1 });
    expect(short.status).toBe('INSUFFICIENT_DATA'); expect(short.value.unavailableModels.length).toBe(6); expect(short.coverage.fraction).toBe(0);
  });
  it('zero-variance reference is flagged (not treated as "everything is anomalous" or "nothing is")', () => {
    expect(robustZDetector(new Array(50).fill(1), [1, 2]).status).toBe('INSUFFICIENT_DATA');
  });
  it('same seed -> same ensemble result', () => {
    const a = detectAnomalies({ reference: ref, evaluation: [1, 2, 3], seed: 5 }); const b = detectAnomalies({ reference: ref, evaluation: [1, 2, 3], seed: 5 });
    expect(a.result_hash).toBe(b.result_hash);
  });
  it('EWMA/CUSUM catch a small persistent drift that robust-z misses', () => {
    const drift = Array.from({ length: 12 }, () => 1.6 + 0.1 * rng.normal());
    expect(robustZDetector(ref, drift).status).toBe('NO_SIGNAL'); expect(cusumDetector(ref, drift).status).toBe('SIGNAL'); expect(ewmaDetector(ref, drift).status).toBe('SIGNAL');
    expect(changePointDetector(ref, drift).model).toBe('change_point');
  });
  it('conformal threshold: resolvable only with enough calibration points', () => {
    expect(conformalThreshold(Array.from({ length: 99 }, (_, i) => i), 0.01).resolvable).toBe(true);
    expect(conformalThreshold([1, 2, 3], 0.01)).toEqual({ value: 3, resolvable: false });
  });
  it('REGRESSION: IF/LOF use a calibration-derived threshold; false-alarm rate on in-distribution data is near the target, not ~30%', () => {
    let fa = 0; let n = 0; const r = new Rng(21);
    for (let trial = 0; trial < 40; trial++) {
      const refS = Array.from({ length: 200 }, () => r.normal()); const ev = Array.from({ length: 5 }, () => r.normal());
      const res = isolationForestDetector(embed(refS), embed(ev, refS.at(-1)), new Rng(trial));
      fa += res.flagged.length; n += ev.length;
    }
    expect(fa / n).toBeLessThan(0.08);
    expect(lofDetector(embed(ref), embed([9, 9.5], ref.at(-1))).status).toBe('SIGNAL');
  });
});
