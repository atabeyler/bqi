import { describe, it, expect } from 'vitest';
import { runOpContagion, propagateOutage } from '../engines/systemic/opContagion.js';
import { runClimate } from '../engines/systemic/climate.js';
import { runDigitalAssets, cpmmSell, splitSell, lendingCascade, stablecoinRun } from '../engines/systemic/digitalAssets.js';
import { probitShift } from '../core/numeric.js';
import { indexSystem } from '../engines/systemic/state.js';
import { hashOf } from '../core/canonical.js';
import { makeSystem, ent, pySys } from './vnextFixtures.js';

const opSys = (over = {}) => ({
  entities: [ent('B1', 'BANK', { cash: 10 }), ent('B2', 'BANK', { cash: 10 }), ent('CCP', 'CCP')],
  opDeps: { horizonHours: 24, nodes: [{ id: 'CLOUD1', kind: 'CLOUD' }, { id: 'CLOUD2', kind: 'CLOUD' }, { id: 'PAY', kind: 'PAYMENT' }, { id: 'SETTLE', kind: 'SETTLEMENT' }],
    dependencies: [{ consumer: 'PAY', provider: 'CLOUD1', criticality: 1, alternate: 'CLOUD2', rerouteShare: 0.5, failoverHours: 6 }, { consumer: 'SETTLE', provider: 'CLOUD1', criticality: 0.5 }],
    flows: [{ payer: 'B1', payee: 'B2', valuePerDay: 100, via: 'PAY' }, { payer: 'B2', payee: 'CCP', valuePerDay: 50, via: 'SETTLE', kind: 'MARGIN' }], ...over },
});
const out = (h) => ({ opDeps: { outages: [{ node: 'CLOUD1', durationHours: h }] } });

describe('M67 cyber & operational contagion', () => {
  it('KNOWN ANSWER: 12h outage of CLOUD1 -> u(CLOUD1)=0.5, u(PAY)=0.375 (50% reroute, 6h failover), u(SETTLE)=0.25; failed flows 37.5 + 12.5', () => {
    const r = runOpContagion(opSys(), out(12)); const u = r.value.nodeUnavailability;
    expect(u.CLOUD1).toBeCloseTo(0.5, 12); expect(u.PAY).toBeCloseTo((1 - 0.5) * 0.5 + 0.5 * Math.min(0.5, 6 / 24), 12); expect(u.SETTLE).toBeCloseTo(0.25, 12);
    expect(r.value.totals.failed).toBeCloseTo(37.5 + 12.5, 10); expect(r.value.totals.scheduled).toBeCloseTo(150, 10); expect(r.value.marginDeliveryFailures[0].unpaidMargin).toBeCloseTo(12.5, 10);
    const b2 = r.value.entities.find((e) => e.entity === 'B2'); expect(b2.inflowLost).toBeCloseTo(37.5, 10); expect(r.status).toBe('UNCALIBRATED');
  });
  it('REJECTS speculative attack/failure probabilities loudly (no "hack probability" score is ever produced)', () => {
    for (const k of ['hackProbability', 'attack_likelihood', 'breachProbability', 'threat_score']) { const bad = out(5); bad.opDeps[k] = 0.2; const r = runOpContagion(opSys(), bad); expect(r.status).toBe('COMPUTATION_FAILED'); expect(r.error).toMatch(/never produces or accepts attack\/failure probabilities/); }
    const s = opSys(); s.opDeps.nodes[0].exploitScore = 7; expect(runOpContagion(s, out(5)).status).toBe('COMPUTATION_FAILED'); const ok = runOpContagion(opSys(), out(5)); expect(JSON.stringify(ok.value)).not.toMatch(/probab|likelihood/i); expect(ok.parameters.noProbabilities).toBe(true);
  });
  it('dependency cycles converge; single points of failure and provider concentration are structural, not probabilistic', () => {
    const s = opSys(); s.opDeps.dependencies.push({ consumer: 'CLOUD1', provider: 'PAY', criticality: 0.3 }); const p = propagateOutage(s.opDeps, [{ node: 'CLOUD1', durationHours: 12 }], { durationScale: 1, rerouteScale: 1 }); expect(p.converged).toBe(true);
    const r = runOpContagion(opSys(), out(12)); expect(r.value.structure.singlePointsOfFailure).toContain('CLOUD1'); expect(r.value.structure.providerConcentration.hhi).toBeGreaterThan(0.5); expect(r.value.structure.singleNodeFullOutageSweep[0].failedFlowValue).toBeGreaterThan(0);
  });
  it('PROPERTY: failed flows are within [0, scheduled], monotone in outage duration, and substitution never worsens the outcome', () => {
    let prev = -1; for (const h of [1, 4, 8, 16, 24, 48]) { const r = runOpContagion(opSys(), out(h)); expect(r.value.totals.failed).toBeGreaterThanOrEqual(prev - 1e-12); expect(r.value.totals.failed).toBeLessThanOrEqual(r.value.totals.scheduled + 1e-9); prev = r.value.totals.failed; }
    const s = opSys(); s.opDeps.dependencies[0].rerouteShare = 0; expect(runOpContagion(s, out(12)).value.totals.failed).toBeGreaterThan(runOpContagion(opSys(), out(12)).value.totals.failed);
    const none = runOpContagion(opSys(), { opDeps: { outages: [] } }); expect(none.value.totals.failed).toBe(0);
  });
  it('MISSING DATA: unobserved substitution terms are treated as NO substitution (stress upper side) and flagged', () => {
    const s = opSys(); s.opDeps.dependencies[0].rerouteShare = null; const r = runOpContagion(s, out(12));
    expect(r.unobserved).toContain('substitution:PAY->CLOUD1'); expect(r.status).toBe('INSUFFICIENT_OBSERVABILITY'); expect(r.value.nodeUnavailability.PAY).toBeCloseTo(0.5, 12); expect(r.value.upperBoundReasons.length).toBe(1);
  });
  it('fails loudly on unknown nodes / invalid durations; deterministic; has assumption-sensitivity block', () => {
    expect(runOpContagion(opSys(), { opDeps: { outages: [{ node: 'ZZ', durationHours: 5 }] } }).error).toMatch(/unknown node/); expect(runOpContagion(opSys(), { opDeps: { outages: [{ node: 'CLOUD1', durationHours: 0 }] } }).status).toBe('COMPUTATION_FAILED');
    const a = runOpContagion(opSys(), out(10), { seed: 1 }); const b = runOpContagion(opSys(), out(10), { seed: 1 }); expect(a.result_hash).toBe(b.result_hash); expect(a.uncertainty.p05).toBeLessThanOrEqual(a.uncertainty.p95); expect(a.input_hashes[0]).toBe(hashOf(opSys().opDeps));
    const f = makeSystem(2); expect(runOpContagion(f, { opDeps: { outages: [{ node: 'CLOUD1', durationHours: 8 }] } }).value.totals.failed).toBeGreaterThan(0);
  });
});

const clim = (over = {}) => ({
  assets: [{ id: 'OIL', price: 10 }],
  entities: [ent('B', 'BANK', { cash: 50, externalAssets: 100, externalLiabilities: 300, holdings: [{ asset: 'OIL', shares: 10 }], creditBook: [{ id: 'c1', amount: 200, pd: 0.03, lgd: 0.45, riskSector: 'ENERGY' }] }), ent('INS', 'INSURER', { cash: 50, externalAssets: 100, externalLiabilities: 100 }), ent('HH', 'HOUSEHOLD', { externalAssets: 300 })],
  exposures: [{ creditor: 'HH', debtor: 'B', amount: 150 }],
  climate: { sectors: { ENERGY: { emissionIntensity: 0.0004, ebitdaMargin: 0.25, physicalAssetShare: 0.5, natureDependency: { water: 0.3 } } }, assetSector: { OIL: 'ENERGY' }, insurance: { ENERGY: { coverage: 0.4, insuredValue: 200 } }, insurers: { INS: { ENERGY: 0.6 } }, parameters: { valuationPassThrough: 1, pdSensitivity: 1.5 }, ...over },
});
const csc = { climate: { transition: { carbonPrice: 100, passThrough: 0.2, abatement: 0.1 }, physical: { damageRatio: { ENERGY: 0.1 } }, nature: { degradation: { water: 0.5 } } } };

describe('M68 climate & nature stress', () => {
  it('KNOWN ANSWER: transition cost, nature revenue loss, EBITDA drop, valuation haircut, PD shift, insured loss (hand computed + Python probit)', () => {
    const r = runClimate(clim(), csc); const e = r.value.sectors.ENERGY;
    const trans = 100 * 0.0004 * 0.9 * 0.8; const nature = 0.3 * 0.5; const drop = (trans + nature) / 0.25; const phys = 0.1 * 0.5; const unins = phys * 0.6;
    expect(e.transitionCostRatio).toBeCloseTo(trans, 12); expect(e.natureRevenueLoss).toBeCloseTo(nature, 12); expect(e.ebitdaDrop).toBeCloseTo(drop, 12); expect(e.physicalUninsured).toBeCloseTo(unins, 12);
    expect(e.valuationHaircut).toBeCloseTo(1 - (1 - drop) * (1 - unins), 12); expect(e.pdShift).toBeCloseTo(1.5 * drop, 12);
    const pd = r.value.effects.find((x) => x.channel === 'PD_SHIFT'); expect(pd.pd1).toBeCloseTo(pySys('probit_shift', { pd: 0.03, shift: 1.5 * drop }), 12); expect(pd.pd1).toBeCloseTo(probitShift(0.03, 1.5 * drop), 12);
    expect(r.value.effects.find((x) => x.channel === 'INSURED_PHYSICAL_LOSS').loss).toBeCloseTo(0.6 * (phys * 0.4) * 200, 10); expect(r.value.assetHaircuts.OIL).toBeCloseTo(e.valuationHaircut, 12);
  });
  it('transmits into balance sheets and systemic loss: holdings revalued, credit EL booked, identity reconciles', () => {
    const r = runClimate(clim(), csc); expect(r.value.contagion.system.reconciled).toBe(true); expect(r.value.contagion.system.directLoss).toBeGreaterThan(10 * 10 * r.value.assetHaircuts.OIL * 0.99); expect(r.value.handoff.priceShocks.OIL).toBeGreaterThan(0);
  });
  it('PROPERTY: losses monotone in carbon price and damage ratio; zero stress -> zero', () => {
    let prev = -1; for (const pc of [0, 25, 50, 100, 200]) { const r = runClimate(clim(), { climate: { transition: { carbonPrice: pc, passThrough: 0.2, abatement: 0.1 } } }); expect(r.value.totals.systemLoss).toBeGreaterThanOrEqual(prev - 1e-9); prev = r.value.totals.systemLoss; }
    prev = -1; for (const d of [0, 0.05, 0.2, 0.5]) { const r = runClimate(clim(), { climate: { physical: { damageRatio: { ENERGY: d } } } }); expect(r.value.totals.systemLoss).toBeGreaterThanOrEqual(prev - 1e-9); prev = r.value.totals.systemLoss; }
    expect(runClimate(clim(), { climate: { transition: { carbonPrice: 0, passThrough: 0, abatement: 0 } } }).value.totals.systemLoss).toBeCloseTo(0, 10);
  });
  it('MISSING DATA: unobserved intensity, margin, insurance, parameters are flagged and the channel excluded (never zero)', () => {
    const a = clim(); a.climate.sectors.ENERGY.ebitdaMargin = null; const ra = runClimate(a, csc); expect(ra.unobserved).toContain('ebitda_margin:ENERGY'); expect(ra.value.sectors.ENERGY.ebitdaDrop).toBeNull(); expect(ra.status).toBe('INSUFFICIENT_OBSERVABILITY');
    const b = clim(); b.climate.sectors.ENERGY.emissionIntensity = null; expect(runClimate(b, csc).unobserved).toContain('emission_intensity:ENERGY');
    const c = clim(); c.climate.insurance.ENERGY.coverage = null; const rc = runClimate(c, csc); expect(rc.unobserved).toContain('insurance_coverage:ENERGY'); expect(rc.value.sectors.ENERGY.physicalUninsured).toBeCloseTo(0.05, 12);
    const d = clim(); d.climate.parameters.pdSensitivity = null; expect(runClimate(d, csc).unobserved).toContain('climate_param:pdSensitivity');
    const e = clim(); e.climate.sectors.ENERGY.natureDependency = {}; expect(runClimate(e, csc).unobserved).toContain('nature_dependency:ENERGY'); expect(runClimate(clim(), csc).value.lowerBound).toBe(false);
  });
  it('fails loudly (no channel, bad fractions, unknown sector); deterministic; non-mutating', () => {
    expect(runClimate(clim(), { climate: {} }).error).toMatch(/at least one/); expect(runClimate(clim(), { climate: { transition: { carbonPrice: 1, passThrough: 2, abatement: 0 } } }).status).toBe('COMPUTATION_FAILED'); expect(runClimate(clim(), { climate: { physical: { damageRatio: { NOPE: 0.1 } } } }).error).toMatch(/NOPE/);
    const s = clim(); const h = hashOf(s); const a = runClimate(s, csc, { seed: 1 }); const b = runClimate(s, csc, { seed: 1 }); expect(a.result_hash).toBe(b.result_hash); expect(hashOf(s)).toBe(h); expect(a.uncertainty.method).toBe('LATIN_HYPERCUBE_ASSUMPTION_BAND');
  });
});

describe('M69 digital assets', () => {
  it('KNOWN ANSWER: constant-product sale: out = y*dx_eff/(x+dx_eff), invariant non-decreasing with fee; Python reference', () => {
    const a = cpmmSell({ x: 1000, y: 2e6, fee: 0.003 }, 100); expect(a.out).toBeCloseTo(pySys('amm_out', { x: 1000, y: 2e6, fee: 0.003, dx: 100 }), 6); expect((a.x1) * (a.y1)).toBeGreaterThanOrEqual(1000 * 2e6 - 1e-6);
    const b = cpmmSell({ x: 1000, y: 2e6, fee: 0 }, 100); expect(b.x1 * b.y1).toBeCloseTo(1000 * 2e6, 3); expect(b.out).toBeCloseTo(2e6 * 100 / 1100, 6);
  });
  it('KNOWN ANSWER: optimal split across identical pools equals the consolidated pool (CPMM property); greedy-routing reference for unequal pools', () => {
    expect(splitSell([{ x: 1000, y: 2e6 }, { x: 1000, y: 2e6 }], 100).out).toBeCloseTo(cpmmSell({ x: 2000, y: 4e6, fee: 0 }, 100).out, 4);
    const pools = [{ x: 1000, y: 2e6 }, { x: 500, y: 1.1e6 }]; expect(Math.abs(splitSell(pools, 150).out - pySys('split_greedy', { pools: pools.map((p) => [p.x, p.y]), q: 150 }))).toBeLessThan(2.5);
    expect(splitSell(pools, 150).out).toBeGreaterThan(cpmmSell({ x: 1000, y: 2e6, fee: 0 }, 150).out);
  });
  const stbSys = (extra = {}) => ({ assets: [{ id: 'TB', price: 100, illiq: 1e-8 }], impact: { model: 'amihud-linear' }, entities: [ent('STB', 'STABLECOIN', { cash: 200, externalLiabilities: 1000, holdings: [{ asset: 'TB', shares: 5 }] }), ent('BANK', 'BANK', { externalAssets: 500, externalLiabilities: 100 })], exposures: [{ creditor: 'STB', debtor: 'BANK', amount: 300 }], digital: { stablecoins: [{ entity: 'STB', token: 'USDS', liquidationHaircut: { TB: 0.02 } }], pools: [], ...extra } });
  it('KNOWN ANSWER: stablecoin run with sequential service -> cash 200, deposits 300, assets 100 (gross 102.04), peg of remaining holders 0.975', () => {
    const r = runDigitalAssets(stbSys(), { digital: { stablecoinRedemptions: { STB: 0.6 } } }); const s = r.value.stablecoinRuns[0];
    expect(s.paidAtPar).toBeCloseTo(600, 9); expect(s.paidFrom.cash).toBeCloseTo(200, 9); expect(s.paidFrom.deposits).toBeCloseTo(300, 9); expect(s.paidFrom.assets).toBeCloseTo(100, 9); expect(s.assetSales.TB).toBeCloseTo(100 / 0.98, 9); expect(s.haircutLoss).toBeCloseTo(100 / 0.98 - 100, 9);
    expect(s.pegPriceRemainingHolders).toBeCloseTo((200 * 0 + 500 * 0.98 - 100 + 0) / 400, 9); expect(s.runnable).toBe(false); expect(r.value.contagion.system.reconciled).toBe(true); expect(r.value.handoff.bankLiquidityOutflow.BANK).toBeCloseTo(300, 9);
    const big = runDigitalAssets(stbSys(), { digital: { stablecoinRedemptions: { STB: 1 } } }).value.stablecoinRuns[0]; expect(big.runnable).toBe(true); expect(big.unpaid).toBeGreaterThan(0); expect(big.paidAtPar).toBeLessThan(1000);
  });
  const defi = () => ({ id: 'L1', entity: 'DEFI', collateralToken: 'ETH', debtToken: 'USD', oraclePool: 'P1', liquidationThreshold: 0.8, liquidationPenalty: 0.05, closeFactor: 0.5, positions: [{ owner: 'a', collateral: 100, debt: 140000 }, { owner: 'b', collateral: 100, debt: 130000 }, { owner: 'c', collateral: 100, debt: 60000 }] });
  it('KNOWN ANSWER: lending health factors, liquidation sizes and AMM feedback; bad debt when collateral is exhausted', () => {
    const pool = { x: 1000, y: 2e6, fee: 0 }; const p = defi(); const hf = (pos) => (pos.collateral * 2000 * 0.8) / pos.debt; expect(hf(p.positions[0])).toBeCloseTo(1.142857, 5);
    const res = lendingCascade(p, { ...pool }, -0.2, 1); // oracle 20% below pool: HF 0.914 for a, 0.985 for b, c safe
    expect(res.rounds[0].liquidatable).toBe(2); expect(res.rounds[0].repaid).toBeCloseTo(0.5 * 140000 + 0.5 * 130000, 6); expect(res.rounds[0].priceAfter).toBeLessThan(2000); expect(res.seizedQty).toBeGreaterThan(0);
    const insolvent = lendingCascade({ ...defi(), positions: [{ owner: 'z', collateral: 10, debt: 100000 }] }, { ...pool }, 0, 1); expect(insolvent.bad).toBeGreaterThan(0); expect(insolvent.converged).toBe(true);
  });
  it('lending cascades are triggered by pool shocks, bridge failures and oracle deviation; bridge backing ratio known answer', () => {
    const sys = () => ({ entities: [ent('DEFI', 'DEFI', { cash: 10, externalAssets: 50, externalLiabilities: 20 })], digital: { pools: [{ id: 'P1', tokenA: 'ETH', tokenB: 'USD', reserveA: 1000, reserveB: 2e6, fee: 0.003 }, { id: 'PW', tokenA: 'WETH', tokenB: 'USD', reserveA: 500, reserveB: 1e6, fee: 0.003 }], lending: [defi()], bridges: [{ id: 'BR', wrappedToken: 'WETH', locked: 800, wrappedSupply: 1000, wrappedPool: 'PW' }] } });
    const calm = runDigitalAssets(sys(), { digital: {} }); expect(calm.value.lending[0].positionsAtRisk).toBe(0);
    const shocked = runDigitalAssets(sys(), { digital: { poolShocks: { P1: 0.15 } } }); expect(shocked.value.lending[0].positionsAtRisk).toBeGreaterThan(0); expect(shocked.value.lending[0].priceDecline).toBeGreaterThan(0.15);
    const dev = runDigitalAssets(sys(), { digital: { oracleDeviation: { L1: -0.2 } } }); expect(dev.value.lending[0].positionsAtRisk).toBeGreaterThan(0);
    const br = runDigitalAssets(sys(), { digital: { bridgeFailures: [{ id: 'BR', lossFractionOfLocked: 0.5 }] } }); expect(br.value.bridges[0].backingRatio).toBeCloseTo(800 * 0.5 / 1000, 12); expect(br.value.bridges[0].wrappedPriceFactor).toBeCloseTo(0.4, 12);
    expect(calm.value.structure.oracleSensitivity.length).toBe(3); expect(calm.value.structure.oracleSensitivity[0].priceDeclineToLiquidation).toBeGreaterThan(0);
  });
  it('liquidity fragmentation: stranded (unreachable) depth raises the execution shortfall vs consolidation', () => {
    const sys = (reach) => ({ entities: [ent('X', 'OTHER')], digital: { pools: [{ id: 'P1', tokenA: 'ETH', tokenB: 'USD', reserveA: 1000, reserveB: 2e6 }, { id: 'P2', tokenA: 'ETH', tokenB: 'USD', reserveA: 1000, reserveB: 2e6, reachable: reach }], venues: [{ token: 'ETH', pools: ['P1', 'P2'] }] } });
    const full = runDigitalAssets(sys(true), { digital: { fragmentationSell: { ETH: 200 } } }).value.fragmentation[0]; const part = runDigitalAssets(sys(false), { digital: { fragmentationSell: { ETH: 200 } } }).value.fragmentation[0];
    expect(full.executionShortfallVsConsolidated).toBeCloseTo(0, 3); expect(part.executionShortfallVsConsolidated).toBeGreaterThan(1000); expect(part.reachableDepthShare).toBeCloseTo(0.5, 12);
  });
  it('MISSING DATA: unobserved pool reserves / liquidation haircuts / impact parameters are flagged, not treated as infinite or zero', () => {
    const s = { entities: [ent('DEFI', 'DEFI', { cash: 10, externalAssets: 50, externalLiabilities: 20 })], digital: { pools: [{ id: 'P1', tokenA: 'ETH', tokenB: 'USD', reserveA: null, reserveB: 2e6 }] } };
    const r = runDigitalAssets(s, { digital: {} }); expect(r.unobserved).toContain('pool_reserves:P1'); expect(r.status).toBe('INSUFFICIENT_OBSERVABILITY'); expect(r.coverage.fraction).toBe(0);
    const t = stbSys(); t.digital.stablecoins[0].liquidationHaircut = {}; expect(runDigitalAssets(t, { digital: { stablecoinRedemptions: { STB: 0.6 } } }).unobserved).toContain('liquidation_haircut:STB:TB');
    const u = stbSys(); u.assets[0].illiq = null; expect(runDigitalAssets(u, { digital: { stablecoinRedemptions: { STB: 0.6 } } }).unobserved.some((x) => x.startsWith('impact_inputs'))).toBe(true);
  });
  it('fails loudly on invalid input; deterministic; reconciles on the fixture', () => {
    expect(runDigitalAssets(stbSys(), { digital: { stablecoinRedemptions: { STB: 2 } } }).status).toBe('COMPUTATION_FAILED'); expect(runDigitalAssets(stbSys(), { digital: { poolShocks: { PX: 0.1 } } }).error).toMatch(/poolShocks/);
    const bad = stbSys(); bad.entities[0].sector = 'BANK'; expect(runDigitalAssets(bad, { digital: {} }).error).toMatch(/STABLECOIN/);
    const f = makeSystem(3); const sc = { digital: { stablecoinRedemptions: { STB: 0.5 }, poolShocks: { P1: 0.12 } } }; const h = hashOf(f); const a = runDigitalAssets(f, sc, { seed: 1 }); const b = runDigitalAssets(f, sc, { seed: 1 }); expect(a.result_hash).toBe(b.result_hash); expect(hashOf(f)).toBe(h); expect(a.value.contagion.system.reconciled).toBe(true);
  });
  it('stablecoinRun is exposed for twin reuse and conserves payments', () => {
    const s = stbSys(); const ix = indexSystem(s); const r = stablecoinRun(s, ix, s.digital.stablecoins[0], 0.3, ix.price, new Array(ix.nA).fill(0)); expect(r.paidAtPar).toBeCloseTo(300, 9); expect(r.paidFrom.cash + r.paidFrom.deposits + r.paidFrom.assets).toBeCloseTo(300, 9);
  });
});
