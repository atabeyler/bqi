import { describe, it, expect } from 'vitest';
import { propagate } from '../engines/systemic/crossSector.js';
import { indexSystem } from '../engines/systemic/state.js';
import { runSovNexus } from '../engines/systemic/nexus.js';
import { runPrivateCredit } from '../engines/systemic/privateCredit.js';
import { runCollateral } from '../engines/systemic/collateral.js';
import { runDigitalAssets } from '../engines/systemic/digitalAssets.js';
import { ccpWaterfall, runCcp } from '../engines/systemic/ccp.js';
import { runSystemTwin } from '../engines/systemic/twin.js';
import { runCascade } from '../engines/cascade.js';
import { validateSurveillance } from '../engines/surveillance/index.js';
import { cmp } from '../core/numeric.js';
import { hashOf, canonicalJson } from '../core/canonical.js';
import { makeSystem, fullScenario, ent } from './vnextFixtures.js';
import { market, base, T0, DAY } from './vnextSurvFixtures.js';

const tw = (s, sc, o = {}, f = null) => runSystemTwin(s, sc, { seed: 1, uncertainty: { n: 1 }, ...o }, f);
const eq = (r, id) => r.value.entities.find((e) => e.id === id);
const rev = (o) => (Array.isArray(o) ? o.map(rev) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).reverse().map(([k, v]) => [k, rev(v)])) : o);

describe('audit: M60 clearing input accounting', () => {
  const net = () => ({ entities: [ent('A', 'BANK', { externalAssets: 10, externalLiabilities: 5 }), ent('B', 'BANK', { externalAssets: 50, externalLiabilities: 10 })], exposures: [{ creditor: 'B', debtor: 'A', amount: 20 }] });
  const solvent = () => ({ entities: [ent('A', 'BANK', { externalAssets: 100, externalLiabilities: 5 }), ent('B', 'BANK', { externalAssets: 50, externalLiabilities: 10 })], exposures: [{ creditor: 'B', debtor: 'A', amount: 20 }] });
  it('REGRESSION: losses beyond an entity\'s external assets are not clipped away (net external position preserved, identity exact)', () => {
    const r = propagate(net(), {}, { alpha: 1, beta: 1, maxIter: 1000 }, { ix: indexSystem(net()), extAssetsDelta: [-30, 0] });
    expect(r.system.reconciled).toBe(true); expect(r.system.identityResidual).toBeCloseTo(0, 9); expect(r.system.directLoss).toBeCloseTo(30, 9); expect(r.system.outsideCreditorLoss).toBeCloseTo(25, 9); // A: assets -20, owes 5 outside + 20 to B
    expect(r.entities[0].defaulted).toBe(true);
  });
  it('REGRESSION: over-repayment (negative outside-liability balance) becomes an asset instead of a negative liability', () => {
    const r = propagate(net(), {}, { alpha: 1, beta: 1, maxIter: 1000 }, { ix: indexSystem(net()), extLiabDelta: [-9, 0] });
    expect(r.system.reconciled).toBe(true); expect(r.entities[0].nominalLiabilities).toBeGreaterThanOrEqual(0); expect(r.system.directLoss).toBeCloseTo(-9, 9);
  });
  it('transfers hit equity but are not value destroyed; identity includes them', () => {
    const r = propagate(solvent(), {}, { alpha: 1, beta: 1, maxIter: 1000 }, { ix: indexSystem(solvent()), transferDelta: [0, -10] });
    expect(r.system.directLoss).toBeCloseTo(0, 12); expect(r.system.transferLoss).toBeCloseTo(10, 12); expect(r.system.systemLoss).toBeCloseTo(0, 12); expect(r.system.equityLoss).toBeCloseTo(10, 9); expect(r.system.reconciled).toBe(true);
  });
});

describe('audit: M62 non-convergence is safe', () => {
  const sys = (over = {}, impact = false) => ({
    assets: [{ id: 'GB', price: 100, duration: 5, convexity: 30 }], ...(impact ? { impact: { model: 'amihud-linear' } } : {}),
    entities: [ent('SOV', 'SOVEREIGN'), ent('B1', 'BANK', { cash: 50, externalAssets: 200, externalLiabilities: 700, holdings: [{ asset: 'GB', shares: 8 }], bank: { rwa: 700, minCapitalRatio: 0.08, corporateRwaShare: 0.6 }, creditBook: [{ id: 'c', amount: 300, pd: 0.03, lgd: 0.45, riskSector: 'CORPORATE', debtToEbitda: 4 }] }), ent('HH', 'HOUSEHOLD', { externalAssets: 700 })],
    exposures: [{ creditor: 'HH', debtor: 'B1', amount: 600 }],
    sovereign: { bondAsset: 'GB', debt: 1000, gdp: 1500, passThrough: 0.6, pdSensitivity: 0.8, creditCrunchPdSensitivity: 0.5, capitalCostSensitivity: 0.5, spreadPerDebtGdpPp: 5000, backstopShare: 1, growthSensitivity: 50, ...over },
  });
  it('REGRESSION: GDP wipe-out / unbounded feedback gives MODEL_UNCERTAIN with finite, serialisable output (previously threw on Infinity)', () => {
    const r = runSovNexus(sys(), { sovereign: { spreadShockBps: 300 } }); expect(r.status).toBe('MODEL_UNCERTAIN'); expect(r.value.converged).toBe(false); expect(r.value.divergedAt).toBeGreaterThan(0); expect(r.notes.join(' ')).toMatch(/DIVERGED/);
    expect(() => canonicalJson(r.value)).not.toThrow(); expect(Number.isFinite(r.value.spreadBpsFinal)).toBe(true);
    const t = tw(sys({}, true), { sovereign: { spreadShockBps: 300 } }); expect(t.status).toBe('MODEL_UNCERTAIN'); expect(() => canonicalJson(t.value)).not.toThrow();
  });
  it('a convergent configuration still converges and is not flagged', () => {
    const r = runSovNexus(sys({ spreadPerDebtGdpPp: 5, growthSensitivity: 0.3 }), { sovereign: { spreadShockBps: 300 } }); expect(r.value.converged).toBe(true); expect(r.value.divergedAt).toBeNull();
  });
  it('null convexity / corporate RWA share are UNOBSERVED (not silently 0 / 1)', () => {
    const s = sys({ spreadPerDebtGdpPp: 5, growthSensitivity: 0.3 }); s.assets[0].convexity = null; s.entities[1].bank.corporateRwaShare = null; const r = runSovNexus(s, { sovereign: { spreadShockBps: 300 } });
    expect(r.unobserved).toContain('bond_convexity:GB'); expect(r.unobserved).toContain('corporate_rwa_share:B1'); expect(r.status).toBe('INSUFFICIENT_OBSERVABILITY');
  });
});

describe('audit: twin transfers between engines are booked once (equity-neutral flows must not change equity)', () => {
  const funded = { funding: { runnable: 0, runoff: 0, stressRunoff: 0, confidenceThreshold: 0.5 } };
  it('REGRESSION: stablecoin deposit withdrawal is a cash-for-liability swap on the bank (previously +equity)', () => {
    const s = { assets: [{ id: 'TB', price: 100, illiq: 1e-10 }], impact: { model: 'amihud-linear' }, entities: [ent('STB', 'STABLECOIN', { externalLiabilities: 400, holdings: [{ asset: 'TB', shares: 1 }] }), ent('BANK', 'BANK', { cash: 1000, externalAssets: 500, externalLiabilities: 1100, ...funded })], exposures: [{ creditor: 'STB', debtor: 'BANK', amount: 300 }], digital: { stablecoins: [{ entity: 'STB', token: 'U', liquidationHaircut: { TB: 0 } }], pools: [] } };
    const r = tw(s, { digital: { stablecoinRedemptions: { STB: 0.5 } } }); expect(eq(r, 'BANK').equityFinal).toBeCloseTo(eq(r, 'BANK').equity0, 6); expect(r.value.system.systemLoss).toBeCloseTo(0, 6); expect(r.value.reconciliation.reconciled).toBe(true);
  });
  it('REGRESSION: private-credit facility draws move cash into a claim on the lender (no equity gain)', () => {
    const loans = Array.from({ length: 4 }, (_, i) => ({ id: `L${i}`, amount: 25, pd: 0, lgd: 0.5, riskSector: 'CORPORATE', sponsor: `S${i % 2}` }));
    const s = { assets: [{ id: 'X', price: 1, illiq: 1e-9 }], impact: { model: 'amihud-linear' }, entities: [ent('PCF', 'PRIVATE_CREDIT', { cash: 5, creditBook: loans, externalLiabilities: 0 }), ent('BANK', 'BANK', { cash: 500, externalAssets: 300, externalLiabilities: 750, ...funded })], exposures: [{ creditor: 'BANK', debtor: 'PCF', amount: 50 }],
      privateCredit: { factor: { rhoGlobal: 0.2, rhoSponsor: 0.1 }, funds: [{ entity: 'PCF', facilityLimit: 120, ltvCovenant: 0.9, unfundedCommitments: 0, gateFraction: 1, investors: [] }] } };
    const r = tw(s, { privateCredit: { stressFactor: 0, nSim: 100, redemptionFractions: { PCF: 0.5 } } }); const pc = runPrivateCredit(s, { privateCredit: { stressFactor: 0, nSim: 100, redemptionFractions: { PCF: 0.5 } } });
    expect(pc.value.funds[0].redemption.drawnOnFacility).toBeGreaterThan(0); expect(eq(r, 'BANK').equityFinal).toBeCloseTo(eq(r, 'BANK').equity0, 6); expect(r.value.reconciliation.reconciled).toBe(true);
  });
  it('FX roll-over repayment and IM cash posting are equity neutral', () => {
    const s = { assets: [{ id: 'X', price: 1, illiq: 1e-9 }], impact: { model: 'amihud-linear' }, entities: [ent('B', 'BANK', { cash: 100, externalAssets: 100, externalLiabilities: 160, ...funded })], exposures: [],
      fx: { spot: 30, market: { Y: 1, sigma: 0.01, advValue: 1e6 }, official: { reserves: 1e6, swapLines: 0, usableShare: 1 }, entities: { B: { fcyAssets: 0, fcyLiabilities: 40, hedgedFraction: 1, fcyShortTermDebt: 40, fcyLiquidAssets: 0, rolloverRate: 0 } } } };
    const r = tw(s, { fx: { depreciation: 0 } }); expect(eq(r, 'B').equityFinal).toBeCloseTo(eq(r, 'B').equity0, 6); expect(r.value.stages[3].perRound[0].totalNeed).toBeCloseTo(40, 9);
    const c = { assets: [{ id: 'EQ', price: 100, sigma: 0.02, illiq: 1e-9 }], impact: { model: 'amihud-linear' }, entities: [ent('HF', 'FUND', { cash: 5000, externalAssets: 0, externalLiabilities: 3000, ...funded }), ent('CCP1', 'CCP')], collateral: { mporDays: 10, confidence: 0.99, haircuts: {}, eligibility: { CCP: ['CASH'] }, nettingSets: [{ id: 'N', party: 'HF', ccp: 'CCP1', positions: [{ asset: 'EQ', exposure: 2000 }], imPosted: 0 }] } };
    const q = tw(c, { collateral: { volMultiplier: 2 }, ccp: undefined }); expect(eq(q, 'HF').equityFinal).toBeCloseTo(eq(q, 'HF').equity0, 6); expect(q.value.channels.imCashClaims).toBeLessThan(0);
  });
  it('REGRESSION: an investor\'s stake loss is a transfer: system loss equals the fund\'s own loss, the investor still loses equity', () => {
    const loans = Array.from({ length: 10 }, (_, i) => ({ id: `L${i}`, amount: 10, pd: 0.1, lgd: 0.5, riskSector: 'CORPORATE', sponsor: `S${i % 2}` }));
    const s = { entities: [ent('PCF', 'PRIVATE_CREDIT', { creditBook: loans }), ent('INS', 'INSURER', { externalAssets: 100 })], exposures: [], privateCredit: { factor: { rhoGlobal: 0.2, rhoSponsor: 0.1 }, funds: [{ entity: 'PCF', facilityLimit: 0, ltvCovenant: 0.5, unfundedCommitments: 0, gateFraction: 1, investors: [{ investor: 'INS', stake: 1 }] }] } };
    const r = runPrivateCredit(s, { privateCredit: { stressFactor: -2, nSim: 100 } }); const f = r.value.funds[0];
    expect(r.value.contagion.system.directLoss).toBeCloseTo(f.creditLoss, 9); expect(r.value.contagion.system.transferLoss).toBeCloseTo(f.equityLoss, 9); expect(r.value.contagion.entities[1].equity0 - r.value.contagion.entities[1].equityFinal).toBeCloseTo(f.equityLoss, 9); expect(r.value.contagion.system.reconciled).toBe(true);
  });
  it('INVARIANT: the full fixture still reconciles after the accounting fixes (12 seeds)', () => {
    for (let seed = 1; seed <= 12; seed++) { const r = tw(makeSystem(seed, { equityRatio: 0.05 }), fullScenario(), { seed }); expect(r.value.reconciliation.reconciled, `seed ${seed}`).toBe(true); expect(r.value.system.systemLoss).toBeGreaterThanOrEqual(-1e-6); }
  }, 120000);
});

describe('audit: M63/M64 no double counting', () => {
  const csys = () => ({ assets: [{ id: 'EQ', price: 100, illiq: 0, sigma: 0.02 }], impact: { model: 'amihud-linear' }, entities: [ent('CCP1', 'CCP'), ent('M1', 'BANK'), ent('M2', 'BANK'), ent('M3', 'BANK')],
    ccps: [{ id: 'CCP1', skinInTheGame: 10, assessmentCap: 1, members: [{ entity: 'M1', im: 30, dfContribution: 20, capital: 100, positions: [{ asset: 'EQ', exposure: 1000 }] }, { entity: 'M2', im: 10, dfContribution: 15, capital: 100, positions: [] }, { entity: 'M3', im: 10, dfContribution: 15, capital: 100, positions: [] }] }] });
  it('variation margin already paid is netted from the CCP loss (move 100, VM paid 60 => loss 40)', () => {
    const s = csys(); const ix = indexSystem(s); const a = ccpWaterfall(s, s.ccps[0], ['M1'], { EQ: 0.1 }, ix); const b = ccpWaterfall(s, s.ccps[0], ['M1'], { EQ: 0.1 }, ix, { vmCollected: { M1: 60 } });
    expect(a.finalLayers.totalLoss).toBeCloseTo(100, 10); expect(b.finalLayers.totalLoss).toBeCloseTo(40, 10); expect(b.memberLoss.M1.variationMarginAlreadyPaid).toBe(60); expect(ccpWaterfall(s, s.ccps[0], ['M1'], { EQ: 0.1 }, ix, { vmCollected: { M1: 500 } }).finalLayers.totalLoss).toBeCloseTo(0, 10);
  });
  it('defaulter IM/DF consumed by the waterfall is reported (so its own creditors cannot also recover it)', () => {
    const s = csys(); const r = runCcp(s, { ccp: { priceShocks: { EQ: 0.1 }, defaulters: ['M1'] } }); expect(r.value.ccps[0].defaulterConsumed.M1).toBeCloseTo(30 + 20, 10);
    const small = runCcp(s, { ccp: { priceShocks: { EQ: 0.02 }, defaulters: ['M1'] } }); expect(small.value.ccps[0].defaulterConsumed.M1).toBeCloseTo(20, 10); // only part of the IM is used
  });
  it('twin: unpaid CCP margin is not also booked as a liability of the defaulter; without the CCP module it still is', () => {
    const s = { assets: [{ id: 'EQ', price: 100, sigma: 0.02, illiq: 0 }], impact: { model: 'amihud-linear' }, entities: [ent('M1', 'BANK', { cash: 0, externalAssets: 50, externalLiabilities: 40, funding: { runnable: 0, runoff: 0, stressRunoff: 0, confidenceThreshold: 0.5 } }), ent('M2', 'BANK', { cash: 1000, externalAssets: 100, externalLiabilities: 100, funding: { runnable: 0, runoff: 0, stressRunoff: 0, confidenceThreshold: 0.5 } }), ent('CCP1', 'CCP')],
      collateral: { mporDays: 10, confidence: 0.99, haircuts: {}, eligibility: { CCP: ['CASH'] }, nettingSets: [{ id: 'N', party: 'M1', ccp: 'CCP1', positions: [{ asset: 'EQ', exposure: 5000 }], imPosted: 0 }] },
      ccps: [{ id: 'CCP1', skinInTheGame: 1, assessmentCap: 1, members: [{ entity: 'M1', im: 1, dfContribution: 1, capital: 10, positions: [{ asset: 'EQ', exposure: 5000 }] }, { entity: 'M2', im: 1, dfContribution: 50, capital: 1000, positions: [] }] }] };
    const withCcp = tw(s, { priceShocks: { EQ: 0.2 }, collateral: {}, ccp: {} }); const without = tw(s, { priceShocks: { EQ: 0.2 }, collateral: {} });
    expect(eq(withCcp, 'M1').marginDefault).toBe(true); expect(withCcp.value.channels['liabilities:collateral']).toBeCloseTo(0, 9); expect(without.value.channels['liabilities:collateral']).toBeGreaterThan(0); expect(withCcp.value.channels.ccpCharges).toBeGreaterThan(0);
    expect(withCcp.value.reconciliation.reconciled && without.value.reconciliation.reconciled).toBe(true);
  });
});

describe('audit: M10 and the systemic layer apply each market impact exactly once', () => {
  it('price after entity selling + fund cascade = cascade run on the entity-impacted price (no second application of either impact)', () => {
    const illiq = 1e-8; const fund = { assets: [{ id: 'A', price: 10, illiq }], impact: { model: 'amihud-linear' }, funds: [{ id: 'FX1', cash: 1e6, debt: 0, marginRatio: null, beta: null, holdings: [{ asset: 'A', shares: 2e6 }], claims: [] }, { id: 'FX2', cash: 1e6, debt: 0, marginRatio: null, beta: null, holdings: [{ asset: 'A', shares: 2e6 }], claims: [] }] };
    const sys = { assets: [{ id: 'A', price: 10, illiq }], impact: { model: 'amihud-linear' }, entities: [ent('B', 'BANK', { cash: 0, holdings: [{ asset: 'A', shares: 3e6 }], externalAssets: 1e8, externalLiabilities: 1.2e8, funding: { runnable: 1e6, runoff: 1, stressRunoff: 1, confidenceThreshold: 0.5 } })], exposures: [] };
    const S = 0.05; const sc = { priceShocks: { A: S }, redemptions: { FX1: 3e6 } };
    const dEntity = illiq * 1e6; // B sells exactly 1e6 of value at round 0
    const nonfund = 1 - (1 - S) * (1 - dEntity); const ref = runCascade(fund, { priceShocks: { A: nonfund }, redemptions: sc.redemptions });
    const r = tw(sys, sc, {}, fund); expect(r.value.finalPrices.A).toBeCloseTo(10 * (1 - nonfund) * (ref.value.finalPrices.A / (10 * (1 - nonfund))), 9); expect(r.value.finalPrices.A).toBeCloseTo(ref.value.finalPrices.A, 9);
    expect(r.value.stages[6].perRound[0].priceDeclines.A).toBeCloseTo(dEntity, 12); expect(r.value.reconciliation.reconciled).toBe(true);
  });
});

describe('audit: null/missing never silently becomes zero', () => {
  it('omitted haircut, AMM fee, CCP positions, bank funding profile and wrong-way LGD are UNOBSERVED', () => {
    const col = { assets: [{ id: 'EQ', price: 100, sigma: 0.02, illiq: 1e-9 }, { id: 'GB', price: 100, sigma: 0.005, illiq: 1e-9 }], impact: { model: 'amihud-linear' }, entities: [ent('HF', 'FUND', { cash: 5000, holdings: [{ asset: 'GB', shares: 50 }] }), ent('D', 'BANK', { cash: 100 })],
      collateral: { mporDays: 10, confidence: 0.99, haircuts: { EQ: 0.2 }, eligibility: { CCP: ['GB', 'CASH'], BILATERAL: ['GB', 'CASH'] }, nettingSets: [{ id: 'N', party: 'HF', counterparty: 'D', positions: [{ asset: 'EQ', exposure: 1000 }], imPosted: 10 }], wwr: { D: { pd: 0.02, rho: 0.3 } } } };
    const r = runCollateral(col, { collateral: {} }); expect(r.unobserved).toContain('haircut:GB'); expect(r.unobserved).toContain('wwr_lgd:D'); expect(r.status).toBe('INSUFFICIENT_OBSERVABILITY');
    const dig = { entities: [ent('DEFI', 'DEFI', { cash: 1, externalAssets: 1, externalLiabilities: 1 })], digital: { pools: [{ id: 'P', tokenA: 'E', tokenB: 'U', reserveA: 10, reserveB: 100 }] } }; expect(runDigitalAssets(dig, { digital: {} }).unobserved).toContain('pool_fee:P');
    const cc = { assets: [{ id: 'EQ', price: 100, illiq: 0 }], impact: { model: 'amihud-linear' }, entities: [ent('CCP1', 'CCP'), ent('M1', 'BANK'), ent('M2', 'BANK')], ccps: [{ id: 'CCP1', skinInTheGame: 1, assessmentCap: 1, members: [{ entity: 'M1', im: 1, dfContribution: 1, capital: 5 }, { entity: 'M2', im: 1, dfContribution: 1, capital: 5, positions: [] }] }] };
    const cr = runCcp(cc, { ccp: { defaulters: ['M1'] } }); expect(cr.unobserved).toContain('ccp_positions:M1'); expect(cr.unobserved).not.toContain('ccp_positions:M2');
    const s = makeSystem(1); delete s.entities[0].funding; const t = tw(s, { priceShocks: { EQ1: 0.1 } }); expect(t.unobserved).toContain('funding:B1'); expect(t.status).toBe('INSUFFICIENT_OBSERVABILITY'); expect(tw(makeSystem(1), { priceShocks: { EQ1: 0.1 } }).unobserved).not.toContain('funding:B1');
  });
});

describe('audit: PIT on nested inputs and determinism', () => {
  it('REGRESSION: a session that closes after asOf is rejected (nested look-ahead), as are late events', () => {
    const m = market(2); const ok = [{ day: 'D0', openTs: T0, closeTs: T0 + DAY }];
    expect(validateSurveillance(base(m, [], { sessions: ok }))).toBeNull();
    expect(validateSurveillance(base(m, [], { sessions: [{ day: 'F', openTs: T0 + 1.9e7, closeTs: T0 + 2.1e7 }] }))).toMatch(/look-ahead guard: session F/);
  });
  it('identical snapshot + seed gives identical hashes regardless of object key order; ties are broken by codepoint, not host locale', () => {
    const s = makeSystem(1); const sc = fullScenario(); const a = tw(s, sc); const b = tw(rev(s), rev(sc)); const c = tw(s, sc);
    expect(hashOf(s)).toBe(hashOf(rev(s))); expect(a.result_hash).toBe(b.result_hash); expect(a.result_hash).toBe(c.result_hash);
    expect(['b', 'B', 'a', 'I', 'ı', 'i'].sort(cmp)).toEqual(['B', 'I', 'a', 'b', 'i', 'ı']);
  }, 60000);
});
