import { describe, it, expect } from 'vitest';
import { normalCdfPrecise, normalInv, vasicekConditionalPd, probitShift, erfc } from '../core/numeric.js';
import { parameterBand } from '../core/sensitivity.js';
import { clearNetwork } from '../engines/systemic/clearing.js';
import { validateSystemState, indexSystem } from '../engines/systemic/state.js';
import { makeSystem, pySys, ent } from './vnextFixtures.js';
import { Rng } from '../core/prng.js';

describe('core numerics (cross-checked against Python statistics.NormalDist)', () => {
  it('normal cdf / inverse match the independent implementation to ~1e-14', () => {
    const x = [-8, -5.5, -3, -1.96, -0.3, 0, 0.7, 1.64, 2.6, 4.4, 7]; const p = [1e-12, 1e-6, 0.001, 0.02, 0.3, 0.5, 0.77, 0.975, 0.999, 1 - 1e-9];
    const ref = pySys('normal', { x, p });
    x.forEach((v, i) => expect(Math.abs(normalCdfPrecise(v) - ref.cdf[i])).toBeLessThan(1e-14 + 1e-10 * ref.cdf[i]));
    p.forEach((v, i) => expect(normalInv(v)).toBeCloseTo(ref.inv[i], 9));
  });
  it('known answers', () => { expect(normalCdfPrecise(0)).toBe(0.5); expect(normalCdfPrecise(1.96)).toBeCloseTo(0.9750021048517795, 13); expect(erfc(0)).toBe(1); expect(normalInv(0.975)).toBeCloseTo(1.959963984540054, 12); });
  it('PROPERTY: inverse(cdf(x)) = x and cdf is monotone', () => { const r = new Rng(3); let prev = -1; for (let i = -60; i <= 60; i++) { const v = normalCdfPrecise(i / 10); expect(v).toBeGreaterThan(prev); prev = v; } for (let i = 0; i < 100; i++) { const x = 8 * (r.next() - 0.5); expect(normalInv(normalCdfPrecise(x))).toBeCloseTo(x, 7); } });
  it('fails loudly on invalid probability', () => { expect(() => normalInv(0)).toThrow(); expect(() => normalInv(1)).toThrow(); });
  it('Vasicek conditional PD and probit shift equal the reference; identity cases', () => {
    expect(vasicekConditionalPd(0.03, 0.2, -2.3)).toBeCloseTo(pySys('vasicek', { pd: 0.03, rho: 0.2, g: -2.3 }), 12);
    expect(probitShift(0.04, 0.7)).toBeCloseTo(pySys('probit_shift', { pd: 0.04, shift: 0.7 }), 12);
    expect(vasicekConditionalPd(0.05, 0.3, 0)).toBeLessThan(0.05); expect(vasicekConditionalPd(0.05, 0.3, -3)).toBeGreaterThan(0.05); expect(probitShift(0.05, 0)).toBeCloseTo(0.05, 13); expect(probitShift(0, 3)).toBe(0); expect(probitShift(1, -3)).toBe(1);
    expect(vasicekConditionalPd(0.05, 0.3, -3)).toBeGreaterThan(vasicekConditionalPd(0.05, 0.3, -1));
  });
});

describe('parameterBand (seeded assumption sensitivity)', () => {
  const f = (p) => p.a * 2 + p.b;
  it('is deterministic, brackets the base value and is honest about its meaning', () => {
    const a = parameterBand({ evaluate: f, params: { a: 1, b: 2 }, keys: ['a', 'b'], n: 40, seed: 5 }); const b = parameterBand({ evaluate: f, params: { a: 1, b: 2 }, keys: ['a', 'b'], n: 40, seed: 5 });
    expect(a).toEqual(b); expect(a.p05).toBeLessThanOrEqual(a.base); expect(a.p95).toBeGreaterThanOrEqual(a.base); expect(a.note).toMatch(/not a confidence interval/);
    expect(a.min).toBeGreaterThanOrEqual(1.6 * 1 + 0 - 1e-9); // lower corner 2*0.8+1.6
    expect(parameterBand({ evaluate: f, params: { a: 1, b: 2 }, keys: ['a', 'b'], n: 40, seed: 6 }).p50).not.toBe(a.p50);
  });
  it('uses explicit ranges and reports NONE when nothing is perturbable', () => {
    const r = parameterBand({ evaluate: f, params: { a: 1, b: 2 }, keys: ['a'], ranges: { a: [0, 10] }, n: 200, seed: 1 }); expect(r.min).toBeGreaterThanOrEqual(2); expect(r.max).toBeLessThanOrEqual(22);
    expect(parameterBand({ evaluate: f, params: { a: null, b: 2 }, keys: ['a'], seed: 1 }).method).toBe('NONE');
  });
});

describe('clearing (Eisenberg-Noe / Rogers-Veraart)', () => {
  it('KNOWN ANSWER: chain A->B->C pays 5 then 10 (hand computed); default waves are ordered', () => {
    const r = clearNetwork({ n: 3, ext: [5, 5, 0], extLiab: [0, 0, 0], edges: [{ c: 1, d: 0, amount: 12 }, { c: 2, d: 1, amount: 15 }] });
    expect(r.p[0]).toBeCloseTo(5, 10); expect(r.p[1]).toBeCloseTo(10, 10); expect(r.wave).toEqual([1, 2, -1]); expect(r.converged).toBe(true);
  });
  it('KNOWN ANSWER with bankruptcy costs alpha=0.5, beta=1: p_A=2.5, p_B=5, deadweight=5', () => {
    const r = clearNetwork({ n: 3, ext: [5, 5, 0], extLiab: [0, 0, 0], edges: [{ c: 1, d: 0, amount: 12 }, { c: 2, d: 1, amount: 15 }], alpha: 0.5, beta: 1 });
    expect(r.p[0]).toBeCloseTo(2.5, 10); expect(r.p[1]).toBeCloseTo(5, 10); expect(r.deadweight.reduce((a, b) => a + b, 0)).toBeCloseTo(5, 10);
  });
  it('PROPERTY vs independent default-set + Gaussian-elimination solver on 40 random networks', () => {
    const r = new Rng(11);
    for (let t = 0; t < 40; t++) {
      const n = 4 + r.int(6); const ext = Array.from({ length: n }, () => 2 + 30 * r.next()); const extLiab = Array.from({ length: n }, () => 20 * r.next() + 0.5);
      const edges = []; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j && r.next() < 0.4) edges.push({ c: i, d: j, amount: 1 + 25 * r.next() });
      const alpha = t % 2 ? 1 : 0.6 + 0.4 * r.next(); const beta = t % 3 ? 1 : 0.6 + 0.4 * r.next();
      const js = clearNetwork({ n, ext, extLiab, edges, alpha, beta, tol: 1e-13 }); const ref = pySys('clearing', { n, ext, extLiab, edges: edges.map((e) => [e.c, e.d, e.amount]), alpha, beta });
      expect(js.converged).toBe(true);
      js.p.forEach((v, i) => expect(Math.abs(v - ref.p[i]), `net ${t} node ${i}`).toBeLessThan(1e-7));
      expect(js.wave.map((w, i) => (w > 0 ? i : -1)).filter((i) => i >= 0)).toEqual(ref.defaulted);
    }
  });
  it('PROPERTY: payments are bounded by liabilities, non-negative and monotone in external assets', () => {
    const r = new Rng(5);
    for (let t = 0; t < 30; t++) {
      const n = 5; const ext = Array.from({ length: n }, () => 20 * r.next()); const extLiab = Array.from({ length: n }, () => 10 * r.next() + 1); const edges = [];
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j && r.next() < 0.5) edges.push({ c: i, d: j, amount: 1 + 12 * r.next() });
      const a = clearNetwork({ n, ext, extLiab, edges }); const b = clearNetwork({ n, ext: ext.map((x) => x * 1.2), extLiab, edges });
      a.p.forEach((p, i) => { expect(p).toBeGreaterThanOrEqual(-1e-12); expect(p).toBeLessThanOrEqual(a.Lbar[i] + 1e-9); expect(b.p[i]).toBeGreaterThanOrEqual(p - 1e-9); });
    }
  });
});

describe('SystemState validation (fail loudly)', () => {
  it('accepts the coherent fixture and rejects each class of invalid input', () => {
    const s = makeSystem(1); expect(validateSystemState(s, { requireImpact: true })).toBeNull();
    const bad = (mut) => { const c = JSON.parse(JSON.stringify(s)); mut(c); return validateSystemState(c); };
    expect(bad((c) => { c.entities[0].sector = 'NOPE'; })).toMatch(/sector/);
    expect(bad((c) => { c.entities[0].cash = -1; })).toMatch(/cash/);
    expect(bad((c) => { c.entities[1].id = c.entities[0].id; })).toMatch(/duplicate/);
    expect(bad((c) => { c.exposures[0].creditor = 'ZZ'; })).toMatch(/unknown entity/);
    expect(bad((c) => { c.exposures[0].debtor = c.exposures[0].creditor; })).toMatch(/self/);
    expect(bad((c) => { c.exposures[0].amount = -3; })).toMatch(/amount/);
    expect(bad((c) => { c.assets[0].price = 0; })).toMatch(/price/);
    expect(bad((c) => { c.entities[0].holdings[0].asset = 'ZZ'; })).toMatch(/unknown asset/);
    expect(bad((c) => { c.entities[0].externalAssets = NaN; })).toMatch(/externalAssets/);
    expect(validateSystemState({ entities: [] })).toMatch(/non-empty/); expect(validateSystemState(null)).toMatch(/required/);
  });
  it('null external fields are legal (UNOBSERVED) and are indexed without becoming zero', () => {
    const s = { entities: [ent('A', 'BANK', { externalAssets: null })], exposures: [] }; expect(validateSystemState(s)).toBeNull(); expect(indexSystem(s).E[0].externalAssets).toBeNull();
  });
});
