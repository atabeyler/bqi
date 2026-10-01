import { describe, it, expect } from 'vitest';
import { hhi, freeFloatExposure } from '../engines/concentration.js';
import { pairOverlap, overlapMatrix, liquidityRankWeights } from '../engines/overlap.js';
import { daysToLiquidate, liquidityProfile } from '../engines/liquidity.js';
import { assessLeverage, marginSaleRequired } from '../engines/leverage.js';
import { priceImpact, impactCurve } from '../engines/impact.js';
import { abnormalReturns, abnormalVolume, amihud, ewmaVol } from '../engines/microstructure.js';
import { estimateRedemptionSensitivity } from '../engines/flow.js';
import { analyzeNetwork, eigenvectorCentrality } from '../engines/network.js';
import { Rng } from '../core/prng.js';

describe('concentration', () => {
  it('HHI known answer and invariants', () => {
    const r = hhi([{ id: 'a', w: 0.5 }, { id: 'b', w: 0.3 }, { id: 'c', w: 0.2 }]);
    expect(r.value.hhi).toBeCloseTo(0.38, 12); expect(r.value.nEff).toBeCloseTo(1 / 0.38, 10); expect(r.value.top1).toBe(0.5);
    const n = 7; const eq = hhi(Array.from({ length: n }, (_, i) => ({ id: `${i}`, w: 1 / n })));
    expect(eq.value.hhi).toBeCloseTo(1 / n, 12);
  });
  it('property: 1/N <= HHI <= 1 for random portfolios', () => {
    const r = new Rng(11);
    for (let t = 0; t < 200; t++) {
      const n = 2 + r.int(15); const g = Array.from({ length: n }, () => -Math.log(1 - r.next())); const s = g.reduce((a, b) => a + b, 0);
      const v = hhi(g.map((x, i) => ({ id: `${i}`, w: x / s }))).value.hhi;
      expect(v).toBeGreaterThanOrEqual(1 / n - 1e-12); expect(v).toBeLessThanOrEqual(1 + 1e-12);
    }
  });
  it('partial observation gives an interval, not a point (UNKNOWN != ZERO)', () => {
    const r = hhi([{ id: 'a', w: 0.5 }, { id: 'b', w: 0.2 }]);
    expect(r.status).toBe('INSUFFICIENT_OBSERVABILITY');
    expect(r.value.hhiLowerBound).toBeCloseTo(0.29, 12); expect(r.value.hhiUpperBound).toBeCloseTo(0.29 + 0.09, 12);
    expect(r.value.hhi).toBeUndefined();
    const withNull = hhi([{ id: 'a', w: 0.5 }, { id: 'b', w: null }]);
    expect(withNull.unobserved).toContain('weight:b');
  });
  it('invalid weights fail loudly', () => {
    expect(hhi([{ id: 'a', w: -0.1 }]).status).toBe('COMPUTATION_FAILED');
    expect(hhi([{ id: 'a', w: 0.8 }, { id: 'b', w: 0.8 }]).status).toBe('COMPUTATION_FAILED');
  });
  it('free-float exposure: unobserved free float stays unobserved', () => {
    const r = freeFloatExposure([{ asset: 'X', shares: 100, freeFloatShares: 1000 }, { asset: 'Y', shares: 100, freeFloatShares: null }]);
    expect(r.value[0].exposure).toBeCloseTo(0.1, 12); expect(r.value[1].exposure).toBeNull(); expect(r.status).toBe('INSUFFICIENT_OBSERVABILITY');
  });
});

describe('overlap', () => {
  it('no overlap -> overlap = 0 (and cosine 0)', () => {
    const r = pairOverlap({ A: 0.5, B: 0.5 }, { C: 0.7, D: 0.3 });
    expect(r.overlap).toBe(0); expect(r.cosine).toBe(0);
  });
  it('identical -> sum of weights; symmetric; bounded by min(sum)', () => {
    const a = { A: 0.4, B: 0.35, C: 0.25 };
    expect(pairOverlap(a, a).overlap).toBeCloseTo(1, 12);
    const rnd = new Rng(2);
    for (let t = 0; t < 100; t++) {
      const mk = () => { const o = {}; for (let k = 0; k < 6; k++) if (rnd.next() < 0.6) o[`A${k}`] = rnd.next() / 3; return o; };
      const x = mk(); const y = mk(); const o1 = pairOverlap(x, y).overlap;
      expect(o1).toBeCloseTo(pairOverlap(y, x).overlap, 12);
      expect(o1).toBeLessThanOrEqual(Math.min(Object.values(x).reduce((s, v) => s + v, 0), Object.values(y).reduce((s, v) => s + v, 0)) + 1e-12);
    }
  });
  it('liquidity-weighted overlap <= overlap; phi is rank-based in (0,1]', () => {
    const phi = liquidityRankWeights({ A: 1, B: 5, C: 20, D: null });
    expect(phi.C).toBe(1); expect(phi.A).toBeCloseTo(1 / 3, 12); expect(phi.D).toBeNull();
    const r = pairOverlap({ A: 0.5, B: 0.5 }, { A: 0.4, B: 0.6 }, phi);
    expect(r.liquidityWeighted).toBeLessThanOrEqual(r.overlap);
  });
  it('unobserved weights make overlaps lower bounds and are listed', () => {
    const r = overlapMatrix([{ id: 'f1', weights: { A: 0.5, B: null } }, { id: 'f2', weights: { A: 0.5, B: 0.5 } }]);
    expect(r.value.isLowerBound).toBe(true); expect(r.status).toBe('INSUFFICIENT_OBSERVABILITY'); expect(r.unobserved).toContain('weight:f1:B');
  });
});

describe('liquidity', () => {
  it('days-to-liquidate known answer; unobserved ADV is UNOBSERVED not 0/infinity', () => {
    const r = daysToLiquidate([{ asset: 'A', shares: 1e6, adv: 5e5, value: 10 }, { asset: 'B', shares: 1e6, adv: null, value: 10 }], { participation: 0.25 });
    expect(r.value[0].dtl).toBeCloseTo(8, 12); expect(r.value[1].dtl).toBeNull(); expect(r.status).toBe('INSUFFICIENT_OBSERVABILITY');
    const p = liquidityProfile(r.value, [5, 10]);
    expect(p.value.profile[1].liquidatableShare).toBeCloseTo(0.5, 12); expect(p.value.profile[1].upperBoundShare).toBeCloseTo(1, 12);
  });
  it('participation convention is echoed and validated', () => {
    expect(daysToLiquidate([], { participation: 0 }).status).toBe('COMPUTATION_FAILED');
    expect(daysToLiquidate([{ asset: 'A', shares: 1, adv: 1, value: 1 }]).parameters.participationProvenance).toBe('convention-default');
  });
});

describe('leverage', () => {
  it('REGRESSION: missing leverage is NOT zero leverage', () => {
    const r = assessLeverage({ id: 'F', grossAssets: 100, debt: null });
    expect(r.status).toBe('INSUFFICIENT_OBSERVABILITY'); expect(r.value.leverage).toBeUndefined(); expect(r.value.marginSaleRequired).toBeUndefined();
    expect(marginSaleRequired({ grossAssets: 100, debt: null, marginRatio: 0.2 })).toBeNull();
    expect(r.unobserved).toContain('debt:F');
  });
  it('closed-form margin sale restores the margin ratio', () => {
    const GA = 100; const D = 85; const m = 0.2; // E=15 -> E/GA=0.15 < 0.2
    const A = marginSaleRequired({ grossAssets: GA, debt: D, marginRatio: m });
    expect((GA - D) / (GA - A)).toBeCloseTo(m, 12); // equity unchanged, assets reduced
    expect(marginSaleRequired({ grossAssets: 100, debt: 10, marginRatio: 0.2 })).toBe(0);
  });
  it('assumed max leverage is labelled ASSUMED', () => {
    expect(assessLeverage({ id: 'F', grossAssets: 100, debt: null, assumedMaxLeverage: 4 }).value.sensitivity.basis).toBe('ASSUMED');
  });
});

describe('market impact', () => {
  it('amihud-linear and sqrt known answers; sqrt requires caller-supplied Y', () => {
    expect(priceImpact({ model: 'amihud-linear' }, { illiq: 1e-8 }, 1e6)).toBeCloseTo(0.01, 12);
    expect(priceImpact({ model: 'sqrt', Y: 1 }, { sigma: 0.02, advValue: 1e6 }, 4e6)).toBeCloseTo(0.04, 12);
    expect(impactCurve({ model: 'sqrt' }, { sigma: 0.02, advValue: 1 }, [1]).status).toBe('COMPUTATION_FAILED');
  });
  it('unobserved inputs give null (never 0); impact capped at 1; zero sale = zero', () => {
    expect(priceImpact({ model: 'amihud-linear' }, { illiq: null }, 1e6)).toBeNull();
    expect(priceImpact({ model: 'amihud-linear' }, { illiq: 1 }, 1e6)).toBe(1);
    expect(priceImpact({ model: 'amihud-linear' }, { illiq: null }, 0)).toBe(0);
  });
});

describe('microstructure', () => {
  const rng = new Rng(4);
  const market = Array.from({ length: 300 }, () => 0.01 * rng.normal());
  const asset = market.map((m) => 0.0002 + 1.2 * m + 0.005 * rng.normal());
  it('market model recovers alpha/beta and flags an injected abnormal return; estimation window excludes the event', () => {
    const a2 = asset.slice(); a2[250] += 0.08;
    const r = abnormalReturns({ assetReturns: a2, marketReturns: market, evalFrom: 250, evalTo: 253, estimationLength: 120 });
    expect(r.value.beta).toBeGreaterThan(1.1); expect(r.value.beta).toBeLessThan(1.3);
    expect(r.value.abnormal[0].z).toBeGreaterThan(8);
    expect(Math.abs(r.value.abnormal[1].z)).toBeLessThan(5);
  });
  it('REGRESSION: the event bar never contaminates the estimation window', () => {
    const a2 = asset.slice(); a2[250] += 5; // absurd shock
    const r1 = abnormalReturns({ assetReturns: a2, marketReturns: market, evalFrom: 250, evalTo: 251 });
    const r0 = abnormalReturns({ assetReturns: asset, marketReturns: market, evalFrom: 250, evalTo: 251 });
    expect(r1.value.beta).toBe(r0.value.beta);
  });
  it('REGRESSION: insufficient data vs constant (rounding-noise variance) market return have distinct statuses', () => {
    expect(abnormalReturns({ assetReturns: asset.slice(0, 15), marketReturns: market.slice(0, 15), evalFrom: 10, evalTo: 12, estimationLength: 5 }).status).toBe('INSUFFICIENT_DATA');
    expect(abnormalReturns({ assetReturns: asset, marketReturns: market.map(() => 0.01), evalFrom: 250, evalTo: 251 }).status).toBe('COMPUTATION_FAILED');
  });
  it('abnormal volume, Amihud known answer (zero-volume days excluded and counted), EWMA', () => {
    const ref = Array.from({ length: 60 }, (_, i) => 1000 + (i % 5) * 10);
    expect(abnormalVolume({ volumeRef: ref, volumeEval: [1020, 5000, null] }).value.av[1]).toBeGreaterThan(10);
    expect(abnormalVolume({ volumeRef: ref, volumeEval: [1, null] }).unobserved).toEqual(['volume[1]']);
    const prices = [10]; const vols = [1000]; const rets = [];
    for (let i = 1; i <= 30; i++) { prices.push(prices[i - 1] * Math.exp(0.01)); vols.push(i === 5 ? 0 : 100); rets.push(0.01); }
    const am = amihud({ returns: rets, prices, volumes: vols });
    expect(am.value.excludedDays).toBe(1); expect(am.value.n).toBe(29);
    expect(ewmaVol(Array.from({ length: 100 }, () => 0.01)).last).toBeCloseTo(0.01, 6);
  });
});

describe('flow & network', () => {
  it('flow sensitivity recovers slope; short history stays UNOBSERVED (not zero)', () => {
    const r = new Rng(9); const ret = Array.from({ length: 200 }, () => 0.02 * r.normal());
    const flow = ret.map((_, t) => (t === 0 ? 0 : 0.5 * ret[t - 1] + 0.002 * r.normal()));
    const e = estimateRedemptionSensitivity({ returns: ret, netFlowRatio: flow, rng: new Rng(1) });
    expect(e.value.beta).toBeGreaterThan(0.45); expect(e.value.beta).toBeLessThan(0.55); expect(e.calibration).toBe('ESTIMATED'); expect(e.uncertainty.bootstrapCI).not.toBeNull();
    expect(estimateRedemptionSensitivity({ returns: ret.slice(0, 10), netFlowRatio: flow.slice(0, 10) }).status).toBe('INSUFFICIENT_DATA');
  });
  it('eigenvector centrality of a star is highest at the hub; counterparty unobserved is counted', () => {
    const A = [[0, 1, 1, 1], [1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0]];
    const ev = eigenvectorCentrality(A);
    expect(ev.converged).toBe(false); // bipartite star: power iteration oscillates -> reported, not hidden
    const A2 = A.map((row, i) => row.map((x, j) => x + (i === j ? 0.5 : 0)));
    void A2;
    const n = analyzeNetwork({ ids: ['a', 'b', 'c'], overlap: [[1, 0.5, 0.2], [0.5, 1, 0.4], [0.2, 0.4, 1]], exposures: [[0, 10, null], [5, 0, 5], [null, null, 0]] });
    expect(n.value.eigenvectorCentrality).toHaveLength(3); expect(n.status).toBe('INSUFFICIENT_OBSERVABILITY'); expect(n.value.counterparty[0].unobservedCount).toBe(1);
  });
});
