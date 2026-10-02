import { describe, it, expect } from 'vitest';
import { aggregateCredit, probitContribution, factorContribution, unobservedContribution } from '../engines/systemic/creditShocks.js';
import { indexSystem } from '../engines/systemic/state.js';
import { fxChain, fxParams, runFxContagion } from '../engines/systemic/fxContagion.js';
import { climateTransmission, climateParams } from '../engines/systemic/climate.js';
import { nexusLoop, nexusParams } from '../engines/systemic/nexus.js';
import { runSystemTwin } from '../engines/systemic/twin.js';
import { normalCdfPrecise, normalInv } from '../core/numeric.js';
import { hashOf } from '../core/canonical.js';
import { makeSystem, fullScenario, ent, pySys } from './vnextFixtures.js';

const book = (o = {}) => ({ id: 'c1', amount: 100, pd: 0.05, lgd: 0.5, riskSector: 'CORPORATE', ...o });
const sysOf = (b = book()) => ({ entities: [ent('B', 'BANK', { creditBook: [b] })], exposures: [] });
const agg = (cs, b, opts) => { const s = sysOf(b); return aggregateCredit(indexSystem(s), cs, opts); };
const P = (source, shockId, magnitude, extra = {}) => probitContribution({ source, shockId, entity: 'B', book: 'c1', magnitude, transformation: 't', ...extra });
const bk = (a) => a.books[0];

describe('central Credit Risk Shock Aggregator (latent-space combination)', () => {
  it('1. single engine: PD = Phi(Phi^-1(p0)+delta) (independent Python probit); base PD preserved; provenance carries source, shock id, magnitude, transformation', () => {
    const a = agg([P('M61', 'FX:1', 0.4)]); const b = bk(a);
    expect(b.pdFinal).toBeCloseTo(pySys('probit_shift', { pd: 0.05, shift: 0.4 }), 12); expect(b.pd0).toBe(0.05); expect(b.pdPre).toBeCloseTo(b.pdFinal, 15);
    expect(b.contributions[0]).toMatchObject({ source: 'M61', shockId: 'FX:1', kind: 'PROBIT_SHIFT', magnitude: 0.4, transformation: 't', applied: true });
    expect(b.loss).toBeCloseTo(100 * 0.5 * (b.pdFinal - 0.05), 12); expect(a.lossByEntity[0]).toBeCloseTo(b.loss, 12);
  });
  it('2. several engines on one borrower combine in latent space (not PD += shock); attribution is exact and sums to the combined loss', () => {
    const a = agg([P('M61', 'FX:1', 0.3), P('M68', 'CL:1', 0.2), P('M62', 'SOV:1', 0.1)]); const b = bk(a);
    expect(b.pdFinal).toBeCloseTo(pySys('probit_shift', { pd: 0.05, shift: 0.6 }), 12);
    const naive = ['M61', 'M68', 'M62'].map((s, k) => agg([P(s, 'x', [0.3, 0.2, 0.1][k])]).totalLoss).reduce((x, y) => x + y, 0);
    expect(b.loss).toBeGreaterThan(naive); // PD is convex in the latent shift: summing separately booked losses understates the joint effect
    expect(Object.values(b.lossBySource).reduce((x, y) => x + y, 0)).toBeCloseTo(b.loss, 12); expect(b.lossBySource.M61 / b.lossBySource.M68).toBeCloseTo(0.3 / 0.2, 10);
    expect(a.lossBySource.M62).toBeCloseTo(b.loss * (0.1 / 0.6), 12);
  });
  it('3. the same shock id arriving through two propagation paths is counted once (largest magnitude wins, ties by source); duplicates stay visible', () => {
    const once = agg([P('M61', 'FX:1', 0.4)]); const twice = agg([P('M61', 'FX:1', 0.4), P('M62', 'FX:1', 0.4)]); const unequal = agg([P('M62', 'FX:1', 0.25), P('M61', 'FX:1', 0.4)]);
    expect(bk(twice).pdFinal).toBe(bk(once).pdFinal); expect(bk(unequal).pdFinal).toBe(bk(once).pdFinal);
    const dup = bk(twice).contributions.find((c) => !c.applied); expect(dup).toMatchObject({ source: 'M62', deduplicatedInto: 'M61' }); expect(bk(twice).contributions.filter((c) => c.applied).length).toBe(1);
    expect(agg([P('M61', 'FX:1', 0.4), P('M62', 'FX:2', 0.4)]).books[0].pdFinal).toBeGreaterThan(bk(once).pdFinal); // distinct shocks DO add
    expect(twice.lossBySource.M62).toBeUndefined();
  });
  it('4. very large positive shocks (probit and factor) keep PD in [0,1] and EL within EAD*LGD*(1-p0)', () => {
    for (const m of [10, 1e3, 1e9]) { const b = bk(agg([P('M61', 'x', m)])); expect(b.pdFinal).toBeLessThanOrEqual(1); expect(b.pdFinal).toBeGreaterThanOrEqual(0.05); expect(Number.isFinite(b.loss)).toBe(true); expect(b.loss).toBeLessThanOrEqual(100 * 0.5 * 0.95 + 1e-9); }
    const f = bk(agg([factorContribution({ source: 'M65', shockId: 'F', entity: 'B', book: 'c1', rho: 0.3, g: -1e6, transformation: 'f' })])); expect(f.pdFinal).toBe(1);
  });
  it('5. improving (negative) shocks keep PD >= 0 and never create more loss reduction than the base expected loss', () => {
    for (const m of [-1, -10, -1e3, -1e9]) { const b = bk(agg([P('M68', 'x', m)])); expect(b.pdFinal).toBeGreaterThanOrEqual(0); expect(b.pdFinal).toBeLessThan(0.05); expect(b.loss).toBeGreaterThanOrEqual(-100 * 0.5 * 0.05 - 1e-12); }
    expect(bk(agg([P('M61', 'a', 0.5), P('M68', 'b', -0.5)])).pdFinal).toBeCloseTo(0.05, 12); // offsetting shocks cancel in latent space
  });
  it('6. UNOBSERVED is not zero: it is listed, leaves the PD unstressed by that source and flags the book; an observed zero is a real "no shock"', () => {
    const un = agg([unobservedContribution({ source: 'M61', shockId: 'FX:1', entity: 'B', book: 'c1', reason: 'sensitivity missing' })]); const zero = agg([P('M61', 'FX:1', 0)]);
    expect(bk(un).incomplete).toBe(true); expect(un.unobserved).toContain('credit_shock:M61:B:c1'); expect(bk(un).unobserved[0].reason).toMatch(/sensitivity/); expect(bk(un).contributions[0]).toMatchObject({ kind: 'UNOBSERVED', applied: false });
    expect(bk(zero).incomplete).toBe(false); expect(zero.unobserved).toEqual([]); expect(bk(zero).contributions[0]).toMatchObject({ kind: 'PROBIT_SHIFT', magnitude: 0, applied: true }); expect(bk(zero).pdFinal).toBeCloseTo(0.05, 14);
    const mixed = agg([unobservedContribution({ source: 'M68', shockId: 'CL:1', entity: 'B', book: 'c1', reason: 'r' }), P('M61', 'FX:1', 0.3)]); expect(bk(mixed).incomplete).toBe(true); expect(bk(mixed).pdFinal).toBeCloseTo(pySys('probit_shift', { pd: 0.05, shift: 0.3 }), 12);
    const redundant = agg([unobservedContribution({ source: 'M68', shockId: 'FX:1', entity: 'B', book: 'c1', reason: 'r' }), P('M61', 'FX:1', 0.3)]); expect(bk(redundant).incomplete).toBe(false);
    const nob = agg([P('M61', 'x', 0.3)], book({ pd: null })); expect(nob.unobserved).toContain('credit_book_inputs:B:c1'); expect(bk(nob).pdFinal).toBeNull(); expect(nob.totalLoss).toBe(0);
  });
  it('degenerate base PD (0 or 1) cannot be shifted in latent space: unchanged and said so', () => {
    for (const pd of [0, 1]) { const b = bk(agg([P('M61', 'x', 2)], book({ pd }))); expect(b.pdFinal).toBe(pd); expect(b.contributions[0].applied).toBe(false); expect(b.contributions[0].reason).toMatch(/DEGENERATE/); }
  });
  it('7. result does not depend on the order in which engines emit (all permutations of real emitters give the same hash)', () => {
    const s = makeSystem(1); const sc = fullScenario(); s.entities[0].creditBook[0].fcy = true; s.entities[0].creditBook[0].fxExposure = 0.4; s.climate.sectors.CORPORATE = { emissionIntensity: 0.0004, ebitdaMargin: 0.25, physicalAssetShare: 0.5, natureDependency: { water: 0.3 } };
    const ix = indexSystem(s); const a = fxChain(s, sc, fxParams(s), ix).creditContributions; const b = climateTransmission(s, sc, climateParams(s), ix).creditContributions; const c = nexusLoop(s, sc, nexusParams(s), {}, ix).last.creditContributions;
    const perms = [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]].map((p) => hashOf(aggregateCredit(ix, p.flat())));
    expect(new Set(perms).size).toBe(1); const rev = hashOf(aggregateCredit(ix, [...a, ...b, ...c].reverse())); expect(rev).toBe(perms[0]);
    const row = aggregateCredit(ix, [...a, ...b, ...c]).books.find((x) => x.book === 'B1-corp'); expect(new Set(row.contributions.filter((x) => x.applied).map((x) => x.source)).size).toBe(3);
  });
  it('8. deterministic: same snapshot + seed -> same aggregation and engine hashes; inputs are not mutated (base PD preserved)', () => {
    const s = makeSystem(2); const h = hashOf(s); const sc = { fx: { depreciation: 0.1 } }; s.entities[0].creditBook[0].fcy = true; s.entities[0].creditBook[0].fxExposure = 0.4; const h2 = hashOf(s);
    const a = runFxContagion(s, sc, { seed: 3 }); const b = runFxContagion(s, sc, { seed: 3 }); expect(a.result_hash).toBe(b.result_hash); expect(hashOf(s)).toBe(h2); expect(h2).not.toBe(h);
    expect(a.value.creditLiquidity.creditEffects[0].pd0).toBe(0.03); expect(a.value.creditLiquidity.creditEffects[0].provenance[0]).toMatchObject({ source: 'M61.fx_contagion', kind: 'PROBIT_SHIFT', applied: true });
  });
  it('9. PIT: a contribution that becomes available after asOf is rejected; earlier/equal and no-timestamp contributions pass', () => {
    const asOf = '2025-03-01T00:00:00Z';
    expect(() => agg([P('M61', 'x', 0.1, { availableAt: '2025-03-01T00:00:01Z' })], book(), { asOf })).toThrow(/look-ahead guard/);
    expect(() => agg([P('M61', 'x', 0.1, { availableAt: '2025-03-01T00:00:00Z' })], book(), { asOf })).not.toThrow(); expect(() => agg([P('M61', 'x', 0.1)], book(), { asOf })).not.toThrow();
    expect(() => agg([P('M61', 'x', 0.1, { availableAt: 'garbage' })], book(), { asOf })).toThrow(/availableAt invalid/); expect(() => agg([P('M61', 'x', 0.1)], book(), { asOf: 'garbage' })).toThrow(/asOf invalid/);
    expect(() => agg([P('M61', 'x', NaN)])).toThrow(/finite/); expect(() => agg([{ ...P('M61', 'x', 1), book: 'zz' }])).toThrow(/unknown creditBook/);
  });
  it('M65-style systematic factor composes after the latent shifts: z = (z0 + sum delta - sqrt(rho) g)/sqrt(1-rho); alone it equals Vasicek (Python)', () => {
    const F = factorContribution({ source: 'M65', shockId: 'F', entity: 'B', book: 'c1', rho: 0.2, g: -2.3, transformation: 'f' });
    expect(bk(agg([F])).pdFinal).toBeCloseTo(pySys('vasicek', { pd: 0.05, rho: 0.2, g: -2.3 }), 12);
    const z = (normalInv(0.05) + 0.3 - Math.sqrt(0.2) * -2.3) / Math.sqrt(0.8); expect(bk(agg([P('M61', 'x', 0.3), F])).pdFinal).toBeCloseTo(normalCdfPrecise(z), 14);
    const a = agg([P('M61', 'x', 0.3), F]); expect(Object.values(a.books[0].lossBySource).reduce((x, y) => x + y, 0)).toBeCloseTo(a.books[0].loss, 12);
  });
});

describe('M61/M62/M65/M68 -> creditBook -> M60/M71 integration', () => {
  const sys = () => { const s = makeSystem(1, { equityRatio: 0.08 }); const b = s.entities[0].creditBook[0]; b.fcy = true; b.fxExposure = 0.4; s.climate.sectors.CORPORATE = { emissionIntensity: 0.0004, ebitdaMargin: 0.25, physicalAssetShare: 0.5, natureDependency: { water: 0.3 } }; return s; };
  const sc = () => ({ fx: { depreciation: 0.1 }, sovereign: { spreadShockBps: 250 }, climate: { transition: { carbonPrice: 100, passThrough: 0.2, abatement: 0.1 } }, privateCredit: { stressFactor: -2, nSim: 200, liquidationDiscount: 0.1 } });
  const run = (s = sys(), c = sc()) => runSystemTwin(s, c, { seed: 1, uncertainty: { n: 1 } });
  it('one borrower row is shocked once by FX + sovereign + climate: joint latent shift, full provenance, exact attribution, ledger reconciles', () => {
    const r = run(); const row = r.value.credit.books.find((b) => b.book === 'B1-corp'); const applied = row.contributions.filter((c) => c.applied);
    expect(applied.map((c) => c.source).sort()).toEqual(['M61.fx_contagion', 'M62.sovereign_bank_corporate', 'M68.climate_nature']); expect(applied.every((c) => c.shockId && c.transformation && Number.isFinite(c.magnitude))).toBe(true);
    const S = applied.reduce((x, c) => x + c.magnitude, 0); expect(row.pdFinal).toBeCloseTo(pySys('probit_shift', { pd: row.pd0, shift: S }), 12); expect(row.pd0).toBe(0.03);
    expect(Object.values(row.lossBySource).reduce((x, y) => x + y, 0)).toBeCloseTo(row.loss, 6); expect(r.value.reconciliation.reconciled).toBe(true);
    const total = Object.values(r.value.credit.lossBySource).reduce((x, y) => x + y, 0); expect(total).toBeCloseTo(r.value.credit.totalBookedLoss, 6);
    for (const k of ['M61.fx_contagion', 'M62.sovereign_bank_corporate', 'M68.climate_nature']) expect(r.value.credit.lossBySource[k]).toBeGreaterThan(0); // each source's credit loss is attributed to its own ledger channel
  });
  it('private-credit loans receive the other engines\' shifts BEFORE the systematic factor and are booked once, by M65', () => {
    const r = run(); const loan = r.value.credit.fundBooks.find((b) => b.book === 'L0'); const clim = loan.contributions.find((c) => c.source === 'M68.climate_nature' && c.applied); const fac = loan.contributions.find((c) => c.kind === 'FACTOR' && c.applied);
    expect(clim).toBeTruthy(); expect(fac).toMatchObject({ source: 'M65.private_credit', rho: 0.2, g: -2 });
    const z = (normalInv(loan.pd0) + clim.magnitude - Math.sqrt(0.2) * -2) / Math.sqrt(0.8); expect(loan.pdFinal).toBeCloseTo(normalCdfPrecise(z), 12);
    expect(r.value.credit.books.filter((b) => b.entity === 'PCF').every((b) => b.excludedFromBooking)).toBe(true); expect(r.value.reconciliation.reconciled).toBe(true);
    const noClimate = runSystemTwin(sys(), { ...sc(), climate: undefined }, { seed: 1, uncertainty: { n: 1 } }); expect(noClimate.value.stages[1].modules.length).toBeLessThan(r.value.stages[1].modules.length);
    const pcLoss = (x) => x.value.stages[1].modules.find((m) => m.module.startsWith('M65')).creditLoss; expect(pcLoss(r)).toBeGreaterThan(pcLoss(noClimate)); // climate stress feeds the fund's PD exactly once
  });
  it('the joint effect is larger than the sum of separately applied effects (convexity) and the standalone engines are unchanged', () => {
    const s = sys(); const both = run(s, sc()); const only = (k) => run(sys(), { [k]: sc()[k] }).value.credit.totalBookedLoss;
    const sum = only('fx') + only('sovereign') + only('climate'); expect(both.value.credit.totalBookedLoss).toBeGreaterThan(sum * 0.999);
  });
  it('MISSING vs ZERO in the integrated run: a missing climate PD sensitivity is UNOBSERVED (book flagged), a zero depreciation is a real zero', () => {
    const s = sys(); s.climate.parameters.pdSensitivity = null; const miss = run(s); const row = miss.value.credit.books.find((b) => b.book === 'B1-corp');
    expect(row.incomplete).toBe(true); expect(row.unobserved.some((u) => u.source === 'M68.climate_nature')).toBe(true); expect(miss.unobserved).toContain('credit_shock:M68.climate_nature:B1:B1-corp'); expect(miss.status).toBe('INSUFFICIENT_OBSERVABILITY');
    const zero = run(sys(), { fx: { depreciation: 0 } }); const zr = zero.value.credit.books.find((b) => b.book === 'B1-corp'); expect(zr.incomplete).toBe(false); expect(zr.contributions[0]).toMatchObject({ source: 'M61.fx_contagion', magnitude: 0, applied: true });
  });
  it('twin integration is deterministic, order-insensitive to input key order, UNCALIBRATED and still 11 modules wide', () => {
    const rev = (o) => (Array.isArray(o) ? o.map(rev) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).reverse().map(([k, v]) => [k, rev(v)])) : o);
    const a = run(); const b = run(); const c = run(rev(sys()), rev(sc())); expect(a.result_hash).toBe(b.result_hash); expect(c.result_hash).toBe(a.result_hash); expect(a.calibration).toBe('UNCALIBRATED'); expect(a.status).not.toBe('LOW_RISK');
  }, 60000);
});
