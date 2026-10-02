import { describe, it, expect } from 'vitest';
import { runCrossSector } from '../engines/systemic/crossSector.js';
import { runFxContagion } from '../engines/systemic/fxContagion.js';
import { hashOf } from '../core/canonical.js';
import { probitShift } from '../core/numeric.js';
import { makeSystem, ent, pySys } from './vnextFixtures.js';

const chain = (extA = 14) => ({ entities: [ent('A', 'BANK', { externalAssets: extA }), ent('B', 'BANK', { externalAssets: 5 }), ent('C', 'HOUSEHOLD')], exposures: [{ creditor: 'B', debtor: 'A', amount: 12 }, { creditor: 'C', debtor: 'B', amount: 15 }] });

describe('M60 cross-sector stress', () => {
  it('KNOWN ANSWER: half of A\'s external assets are lost -> A pays 7, B pays 12, C loses 3; waves, loss and identity (hand computed)', () => {
    const r = runCrossSector(chain(), { externalShocks: { A: 0.5 } }); const v = r.value; const by = Object.fromEntries(v.entities.map((e) => [e.id, e]));
    expect(by.A.paid).toBeCloseTo(7, 10); expect(by.B.paid).toBeCloseTo(12, 10); expect(by.C.equityFinal).toBeCloseTo(12, 10);
    expect([by.A.wave, by.B.wave, by.C.wave]).toEqual([1, 2, -1]); expect(v.waves.map((w) => w.defaulted.map((d) => d.id))).toEqual([['A'], ['B']]);
    expect(v.system.directLoss).toBeCloseTo(7, 10); expect(v.system.systemLoss).toBeCloseTo(7, 10); expect(v.system.equityLoss).toBeCloseTo(7, 10); expect(v.system.reconciled).toBe(true);
    expect(v.sectors.HOUSEHOLD.equityLoss).toBeCloseTo(3, 10); expect(v.transmission.BANK.HOUSEHOLD).toBeCloseTo(3, 10); expect(v.transmission.BANK.BANK).toBeCloseTo(5, 10);
    expect(r.status).toBe('UNCALIBRATED'); expect(r.calibration).toBe('UNCALIBRATED');
  });
  it('KNOWN ANSWER with bankruptcy costs alpha=0.5, beta=1: deadweight 6, system loss 13, identity holds', () => {
    const r = runCrossSector(chain(), { externalShocks: { A: 0.5 } }, { alpha: 0.5, beta: 1 }); const by = Object.fromEntries(r.value.entities.map((e) => [e.id, e]));
    expect(by.A.paid).toBeCloseTo(3.5, 10); expect(by.B.paid).toBeCloseTo(6, 10); expect(r.value.system.deadweightLoss).toBeCloseTo(6, 10); expect(r.value.system.systemLoss).toBeCloseTo(13, 10); expect(r.value.system.reconciled).toBe(true);
  });
  it('sector shocks haircut every entity of the sector; amplification >= 1 when contagion adds loss', () => {
    const r = runCrossSector(chain(), { sectorShocks: { BANK: 0.5 } }); expect(r.value.system.directLoss).toBeCloseTo(0.5 * 14 + 0.5 * 5, 10); expect(r.value.system.amplification).toBeGreaterThanOrEqual(1 - 1e-12);
  });
  it('no shock on a solvent system -> no loss, no default, no waves', () => {
    const s = makeSystem(2); const r = runCrossSector(s, {}); expect(r.value.system.systemLoss).toBeCloseTo(0, 6); expect(r.value.system.defaults).toBe(0); expect(r.value.waves).toEqual([]);
  });
  it('PROPERTY: identity reconciles and loss is monotone in shock size for 20 random solvent systems', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const s = makeSystem(seed, { equityRatio: 0.05 }); let prev = -1;
      for (const k of [0, 0.05, 0.1, 0.2, 0.4]) { const r = runCrossSector(s, { priceShocks: { EQ1: k, EQ2: k }, sectorShocks: { CORPORATE: k / 2 } }); expect(r.value.system.reconciled, `seed ${seed} k ${k}`).toBe(true); expect(r.value.system.systemLoss).toBeGreaterThanOrEqual(prev - 1e-6); prev = r.value.system.systemLoss; }
    }
  });
  it('MISSING DATA: unobserved external assets / exposure amounts are excluded, listed and never read as zero or LOW_RISK', () => {
    const c = chain(); c.entities[1].externalAssets = null; c.entities.push(ent('D', 'FUND', { externalAssets: 3 })); c.exposures.push({ creditor: 'D', debtor: 'A', amount: null });
    const r = runCrossSector(c, { externalShocks: { A: 0.5 } });
    expect(r.status).toBe('INSUFFICIENT_OBSERVABILITY'); expect(r.unobserved).toContain('externalAssets:B'); expect(r.coverage.fraction).toBeLessThan(1); expect(r.value.lowerBound).toBe(true); expect(r.value.entities.find((e) => e.id === 'B').equityFinal).toBeNull(); expect(r.status).not.toBe('LOW_RISK');
  });
  it('fails loudly on invalid input', () => {
    expect(runCrossSector(chain(), { externalShocks: { A: 1.5 } }).status).toBe('COMPUTATION_FAILED'); expect(runCrossSector(chain(), { externalShocks: { Z: 0.1 } }).error).toMatch(/unknown entity/);
    expect(runCrossSector(chain(), { sectorShocks: { NOPE: 0.1 } }).error).toMatch(/unknown sector/); expect(runCrossSector(chain(), {}, { alpha: 2 }).error).toMatch(/alpha/); expect(runCrossSector({ entities: [] }, {}).status).toBe('COMPUTATION_FAILED');
  });
  it('is deterministic, does not mutate its input, carries an assumption-sensitivity block and input hash', () => {
    const s = makeSystem(3); const h = hashOf(s); const a = runCrossSector(s, { priceShocks: { EQ1: 0.2 } }, { alpha: 0.9, beta: 0.9, seed: 4 }); const b = runCrossSector(s, { priceShocks: { EQ1: 0.2 } }, { alpha: 0.9, beta: 0.9, seed: 4 });
    expect(a.result_hash).toBe(b.result_hash); expect(hashOf(s)).toBe(h); expect(a.input_hashes).toEqual([h]); expect(a.uncertainty.method).toBe('LATIN_HYPERCUBE_ASSUMPTION_BAND'); expect(a.uncertainty.p05).toBeLessThanOrEqual(a.uncertainty.p95); expect(a.parameters.assumptions.length).toBeGreaterThan(0);
  });
});

const fxSys = () => ({
  assets: [{ id: 'EQ', price: 10, illiq: 1e-9 }], impact: { model: 'amihud-linear' },
  entities: [ent('B', 'BANK', { cash: 10, externalAssets: 100, externalLiabilities: 80 }), ent('FI', 'FOREIGN_INVESTOR', { holdings: [{ asset: 'EQ', shares: 50 }] })],
  exposures: [],
  fx: { spot: 30, market: { Y: 1, sigma: 0.01, advValue: 200 }, official: { reserves: 100, swapLines: 0, usableShare: 0.5 }, entities: { B: { fcyAssets: 20, fcyLiabilities: 50, hedgedFraction: 0.5, fcyShortTermDebt: 30, fcyLiquidAssets: 5, rolloverRate: 0.5 } } },
});

describe('M61 FX & cross-border contagion', () => {
  it('KNOWN ANSWER (exogenous depreciation 10%): net open position effect = d*(fcyAssets - fcyLiab*(1-hedge))', () => {
    const r = runFxContagion(fxSys(), { fx: { depreciation: 0.1 } }); const e = r.value.balanceSheet.effects[0];
    expect(e.assetGain).toBeCloseTo(2, 12); expect(e.liabilityIncrease).toBeCloseTo(2.5, 12); expect(e.netLoss).toBeCloseTo(0.5, 12); expect(r.value.contagion.system.directLoss).toBeCloseTo(0.5, 10); expect(r.value.exchangeRate.spot1).toBeCloseTo(33, 10);
  });
  it('KNOWN ANSWER (capital flow): demand, official supply, excess demand and sqrt-impact depreciation Y*sigma*sqrt(X/ADV)', () => {
    const r = runFxContagion(fxSys(), { fx: { capitalFlow: { FI: 0.5 } } }); const v = r.value;
    expect(v.capitalFlow.fcyDemand).toBeCloseTo(250, 10); expect(v.fxLiquidity.debtRolloverDemand).toBeCloseTo(10, 10); expect(v.fxLiquidity.officialSupply).toBeCloseTo(50, 10); expect(v.fxLiquidity.excessDemand).toBeCloseTo(210, 10);
    expect(v.exchangeRate.depreciation).toBeCloseTo(1 * 0.01 * Math.sqrt(210 / 200), 12); expect(v.handoff.domesticAssetSales.EQ).toBeCloseTo(250, 10);
  });
  it('FX-sensitive credit book: PD shift equals the probit formula (independent Python check)', () => {
    const s = fxSys(); s.entities[0].creditBook = [{ id: 'c', amount: 100, pd: 0.05, lgd: 0.5, riskSector: 'CORPORATE', fcy: true, fxExposure: 0.4 }]; s.fx.pdSensitivity = 2;
    const r = runFxContagion(s, { fx: { depreciation: 0.1 } }); const ce = r.value.creditLiquidity.creditEffects[0];
    expect(ce.pd1).toBeCloseTo(pySys('probit_shift', { pd: 0.05, shift: 2 * 0.1 * 0.4 }), 12); expect(ce.pd1).toBeCloseTo(probitShift(0.05, 0.08), 12); expect(ce.loss).toBeCloseTo(100 * 0.5 * (ce.pd1 - 0.05), 10);
  });
  it('FCY exposures are revalued for debtor and creditor; hedged part is not', () => {
    const s = fxSys(); s.entities.push(ent('C', 'CORPORATE', { externalAssets: 200, externalLiabilities: 10 })); s.entities[0].externalLiabilities = 40; s.exposures = [{ creditor: 'B', debtor: 'C', amount: 100, currency: 'FCY', fxHedged: 0.25 }];
    const r = runFxContagion(s, { fx: { depreciation: 0.2 } }); const c = r.value.contagion.entities.find((x) => x.id === 'C'); expect(c.nominalLiabilities).toBeCloseTo(10 + 100 * (1 + 0.2 * 0.75), 10);
  });
  it('PROPERTY: depreciation is monotone in outflow fraction and impact coefficient; zero inputs give zero effect; identity reconciles', () => {
    let prev = -1; for (const phi of [0, 0.1, 0.3, 0.6, 1]) { const r = runFxContagion(fxSys(), { fx: { capitalFlow: { FI: phi } } }); expect(r.value.contagion.system.reconciled).toBe(true); expect(r.value.exchangeRate.depreciation).toBeGreaterThanOrEqual(prev); prev = r.value.exchangeRate.depreciation; }
    const s1 = fxSys(); const s2 = fxSys(); s2.fx.market.Y = 2; expect(runFxContagion(s2, { fx: { capitalFlow: { FI: 0.5 } } }).value.exchangeRate.depreciation).toBeGreaterThan(runFxContagion(s1, { fx: { capitalFlow: { FI: 0.5 } } }).value.exchangeRate.depreciation);
    const z = runFxContagion(fxSys(), { fx: { rolloverRates: { B: 1 } } }); expect(z.value.exchangeRate.depreciation).toBe(0); expect(z.value.contagion.system.directLoss).toBeCloseTo(0, 12);
    for (let seed = 1; seed <= 10; seed++) { const s = makeSystem(seed); const r = runFxContagion(s, { fx: { depreciation: 0.15, capitalFlow: { FI: 0.4 } } }); expect(r.value.contagion.system.reconciled).toBe(true); }
  });
  it('MISSING DATA: unobserved hedge ratio, official liquidity, impact parameters and sensitivities are flagged, never zero', () => {
    const s = fxSys(); s.fx.entities.B.hedgedFraction = null; const a = runFxContagion(s, { fx: { depreciation: 0.1 } });
    expect(a.unobserved).toContain('fx_hedged_fraction:B'); expect(a.status).toBe('INSUFFICIENT_OBSERVABILITY'); expect(a.value.upperBoundHedgeLoss).toBeCloseTo(0.1 * 50, 10); expect(a.value.balanceSheet.effects[0].liabilityIncrease).toBe(0);
    const t = fxSys(); t.fx.official.reserves = null; const b = runFxContagion(t, { fx: { capitalFlow: { FI: 0.5 } } }); expect(b.unobserved).toContain('fx_official_liquidity'); expect(b.value.exchangeRate.endogenous).toBe(0); expect(b.status).toBe('INSUFFICIENT_OBSERVABILITY');
    const u = fxSys(); u.fx.market.sigma = null; const c = runFxContagion(u, { fx: { capitalFlow: { FI: 0.5 } } }); expect(c.unobserved).toContain('fx_market_impact_inputs');
    const w = fxSys(); w.fx.entities.B.rolloverRate = undefined; const d = runFxContagion(w, { fx: { capitalFlow: { FI: 0.1 } } }); expect(d.unobserved).toContain('fx_rollover_inputs:B');
    const x = fxSys(); x.entities[0].creditBook = [{ id: 'c', amount: 10, pd: 0.05, lgd: 0.5, riskSector: 'CORPORATE', fcy: true, fxExposure: 0.4 }]; delete x.fx.pdSensitivity; expect(runFxContagion(x, { fx: { depreciation: 0.1 } }).unobserved).toContain('fx_credit_inputs:B:c');
  });
  it('fails loudly: non-foreign capital-flow entity, bad depreciation, missing fx section', () => {
    expect(runFxContagion(fxSys(), { fx: { capitalFlow: { B: 0.5 } } }).error).toMatch(/not a FOREIGN_INVESTOR/); expect(runFxContagion(fxSys(), { fx: { depreciation: 1.5 } }).status).toBe('COMPUTATION_FAILED');
    const s = fxSys(); delete s.fx; expect(runFxContagion(s, {}).error).toMatch(/system.fx required/); const t = fxSys(); t.fx.spot = 0; expect(runFxContagion(t, {}).error).toMatch(/spot/);
  });
  it('is deterministic with uncertainty block and hashes', () => {
    const s = makeSystem(4); const a = runFxContagion(s, { fx: { depreciation: 0.1, capitalFlow: { FI: 0.3 } } }, { seed: 2 }); const b = runFxContagion(s, { fx: { depreciation: 0.1, capitalFlow: { FI: 0.3 } } }, { seed: 2 });
    expect(a.result_hash).toBe(b.result_hash); expect(a.uncertainty.method).toMatch(/LATIN|NONE/); expect(a.input_hashes[0]).toBe(hashOf(s)); expect(a.calibration).toBe('UNCALIBRATED');
  });
});
