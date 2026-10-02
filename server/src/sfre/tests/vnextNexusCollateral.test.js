import { describe, it, expect } from 'vitest';
import { runSovNexus, bondPriceFactor, nexusLoop, nexusParams } from '../engines/systemic/nexus.js';
import { runCollateral, nettingSigma, initialMargin, expectedPositiveExposure, wrongWayExpectedLoss } from '../engines/systemic/collateral.js';
import { runCcp } from '../engines/systemic/ccp.js';
import { marginSaleRequired } from '../engines/leverage.js';
import { indexSystem } from '../engines/systemic/state.js';
import { hashOf } from '../core/canonical.js';
import { makeSystem, ent, pySys } from './vnextFixtures.js';

const nexusSys = (over = {}) => ({
  assets: [{ id: 'GB', price: 100, duration: 5, convexity: 30 }],
  entities: [ent('SOV', 'SOVEREIGN'), ent('B1', 'BANK', { cash: 50, externalAssets: 200, externalLiabilities: 0, holdings: [{ asset: 'GB', shares: 5, book: 'MARKET' }, { asset: 'GB', shares: 3, book: 'HTM' }], bank: { rwa: 700, minCapitalRatio: 0.08, corporateRwaShare: 0.6 }, creditBook: [{ id: 'c1', amount: 300, pd: 0.03, lgd: 0.45, riskSector: 'CORPORATE', debtToEbitda: 4 }] }), ent('HH', 'HOUSEHOLD', { externalAssets: 700 })],
  exposures: [{ creditor: 'HH', debtor: 'B1', amount: 600 }],
  sovereign: { bondAsset: 'GB', debt: 1000, gdp: 1500, passThrough: 0, pdSensitivity: 0, creditCrunchPdSensitivity: 0, capitalCostSensitivity: 0, spreadPerDebtGdpPp: 0, backstopShare: 0, growthSensitivity: 0, ...over },
});
// B1: assets 50+800+300+200 = 1350; liabilities 600 + extLiab -> set equity0 = 200
const nx = (over) => { const s = nexusSys(over); s.entities[1].externalLiabilities = 1350 - 600 - 200; return s; };

describe('M62 sovereign-bank-corporate nexus', () => {
  it('KNOWN ANSWER (no feedback): bond factor 1-D*dy+0.5*C*dy^2, market vs HTM treatment, accounting capital ratio', () => {
    const r = runSovNexus(nx(), { sovereign: { spreadShockBps: 300 } }); const f = 1 - 5 * 0.03 + 0.5 * 30 * 0.03 ** 2; const b = r.value.banks[0];
    expect(r.value.bondPriceFactor).toBeCloseTo(f, 12); expect(f).toBeCloseTo(0.8635, 12); expect(b.htmUnrealisedLoss).toBeCloseTo(3 * 100 * (1 - f), 9);
    expect(b.equityEconomic).toBeCloseTo(200 - 8 * 100 * (1 - f), 8); expect(b.equityAccounting).toBeCloseTo(b.equityEconomic + b.htmUnrealisedLoss, 8); expect(b.capitalRatio).toBeCloseTo(b.equityAccounting / 700, 12);
    expect(r.value.spreadBpsFinal).toBeCloseTo(300, 9); expect(r.value.amplification).toBeCloseTo(1, 9); expect(r.value.converged).toBe(true); expect(r.status).toBe('UNCALIBRATED');
  });
  it('bond pricing agrees with exact cash-flow repricing within the stated second-order error (independent Python check)', () => {
    const ref = pySys('bond', { coupon: 5, maturity: 10, y: 0.05, dy: 0.02 });
    expect(bondPriceFactor(ref.duration, ref.convexity, 0.02)).toBeCloseTo(ref.taylor, 12); expect(Math.abs(bondPriceFactor(ref.duration, ref.convexity, 0.02) - ref.exact)).toBeLessThan(2e-3);
    expect(bondPriceFactor(5, 0, 0)).toBe(1); expect(bondPriceFactor(5, 0, 0.5)).toBe(0.0 + Math.max(0, 1 - 2.5));
  });
  it('feedback loop: with positive sensitivities the spread amplifies and the loop is traced; more shock => weakly more shortfall', () => {
    const p = { passThrough: 0.6, pdSensitivity: 0.8, creditCrunchPdSensitivity: 0.5, capitalCostSensitivity: 0.5, spreadPerDebtGdpPp: 5, backstopShare: 0.5, growthSensitivity: 0.3 };
    let prev = -1; let amp = null;
    for (const bps of [100, 300, 500, 800]) { const r = runSovNexus(nx(p), { sovereign: { spreadShockBps: bps } }); expect(r.value.converged).toBe(true); const sh = r.value.banks[0].capitalShortfall; expect(sh).toBeGreaterThanOrEqual(prev - 1e-9); prev = sh; amp = r.value.amplification; expect(r.value.contagion.system.reconciled).toBe(true); expect(r.value.trace.length).toBeGreaterThanOrEqual(1); }
    expect(amp).toBeGreaterThanOrEqual(1);
  });
  it('MISSING PARAMETERS are UNOBSERVED (channel excluded), never an implicit zero effect', () => {
    const r = runSovNexus(nx({ spreadPerDebtGdpPp: null, passThrough: null }), { sovereign: { spreadShockBps: 300 } });
    expect(r.unobserved).toContain('nexus_param:spreadPerDebtGdpPp'); expect(r.unobserved).toContain('nexus_param:passThrough'); expect(r.status).toBe('INSUFFICIENT_OBSERVABILITY'); expect(r.value.lowerBound).toBe(true); expect(r.value.spreadBpsFinal).toBeCloseTo(300, 9);
  });
  it('HTM-only bank: accounting equity unchanged while economic equity falls', () => {
    const s = nx(); s.entities[1].holdings = [{ asset: 'GB', shares: 8, book: 'HTM' }]; const r = runSovNexus(s, { sovereign: { spreadShockBps: 300 } }); const b = r.value.banks[0];
    expect(b.equityAccounting).toBeCloseTo(b.equityEconomic + b.htmUnrealisedLoss, 8); expect(b.equityAccounting).toBeGreaterThan(b.equityEconomic);
  });
  it('data-flow: losses booked by other engines (pre) enlarge the bank capital shortfall seen by the loop', () => {
    const s = nx({ passThrough: 0.6, pdSensitivity: 0.8, creditCrunchPdSensitivity: 0.5, capitalCostSensitivity: 0.5, spreadPerDebtGdpPp: 5, backstopShare: 0.5, growthSensitivity: 0.3 }); const ix = indexSystem(s); const p = nexusParams(s);
    const a = nexusLoop(s, { sovereign: { spreadShockBps: 200 } }, p, {}, ix); const b = nexusLoop(s, { sovereign: { spreadShockBps: 200 } }, p, {}, ix, { extAssetsDelta: [0, -100, 0] });
    expect(b.last.sumShort).toBeGreaterThan(a.last.sumShort); expect(b.spreadBpsFinal).toBeGreaterThanOrEqual(a.spreadBpsFinal);
  });
  it('fails loudly: missing duration, bad shock, bad parameters; deterministic and non-mutating', () => {
    const s = nx(); s.assets[0].duration = null; expect(runSovNexus(s, { sovereign: { spreadShockBps: 100 } }).status).toBe('COMPUTATION_FAILED');
    expect(runSovNexus(nx(), { sovereign: { spreadShockBps: -5 } }).error).toMatch(/spreadShockBps/); expect(runSovNexus(nx({ backstopShare: 2 }), { sovereign: { spreadShockBps: 5 } }).error).toMatch(/backstopShare/);
    const t = nx({ passThrough: 0.5, spreadPerDebtGdpPp: 2, backstopShare: 0.4, growthSensitivity: 0.1 }); const h = hashOf(t); const a = runSovNexus(t, { sovereign: { spreadShockBps: 200 } }, { seed: 3 }); const b = runSovNexus(t, { sovereign: { spreadShockBps: 200 } }, { seed: 3 });
    expect(a.result_hash).toBe(b.result_hash); expect(hashOf(t)).toBe(h); expect(a.uncertainty.method).toBe('LATIN_HYPERCUBE_ASSUMPTION_BAND');
  });
});

describe('M63 margin, repo, collateral & wrong-way risk', () => {
  const col = (over = {}) => ({
    assets: [{ id: 'EQ', price: 100, sigma: 0.02, illiq: 1e-7 }, { id: 'GB', price: 100, sigma: 0.005, illiq: 1e-8 }], impact: { model: 'amihud-linear' },
    entities: [ent('HF', 'FUND', { cash: 200, holdings: [{ asset: 'GB', shares: 50 }, { asset: 'EQ', shares: 20 }] }), ent('DLR', 'BANK', { cash: 1000 }), ent('CCP1', 'CCP')],
    collateral: { mporDays: 10, confidence: 0.99, haircuts: { GB: 0.05, EQ: 0.2 }, eligibility: { CCP: ['GB', 'CASH'], BILATERAL: ['GB', 'CASH'] }, nettingSets: [{ id: 'NS1', party: 'HF', counterparty: 'DLR', positions: [{ asset: 'EQ', exposure: 5000 }], imPosted: 0 }], repo: [], wwr: { DLR: { pd: 0.02, rho: 0.5, lgd: 0.6 } }, ...over },
  });
  it('KNOWN ANSWER: IM = z*sigma*sqrt(MPOR) (Python), netting-mode sigmas by hand', () => {
    const r = runCollateral(col(), { collateral: {} }); const ns = r.value.netting[0];
    expect(ns.sigma).toBeCloseTo(100, 10); expect(ns.imBase).toBeCloseTo(pySys('im', { q: 0.99, sigma: 100, mpor: 10 }), 9); expect(initialMargin(100, 0.99, 10)).toBeCloseTo(735.6, 0);
    const pos = [{ asset: 'A', exposure: 3000 }, { asset: 'B', exposure: -4000 }]; const sg = (id) => ({ A: 0.02, B: 0.01 })[id];
    expect(nettingSigma(pos, sg, 'NO_OFFSET')).toBeCloseTo(100, 10); expect(nettingSigma(pos, sg, 'INDEPENDENT')).toBeCloseTo(Math.sqrt(3600 + 1600), 10); expect(nettingSigma(pos, sg, 'MATRIX', { A: { B: 0.5 } })).toBeCloseTo(Math.sqrt(5200 - 4800 * 0.5), 10);
  });
  const rich = (over) => { const s = col(over); s.entities[0].cash = 5000; return s; }; // enough cash: no fire sales, so round-0 numbers are exactly the closed forms
  it('KNOWN ANSWER: variation margin = exposure x price decline; stressed IM scales with the vol multiplier', () => {
    const r = runCollateral(rich(), { collateral: { priceShocks: { EQ: 0.1 } } }); expect(r.value.entityCalls.find((e) => e.id === 'HF').vm).toBeCloseTo(500, 8);
    const a = runCollateral(col(), { collateral: { volMultiplier: 1 } }); const b = runCollateral(col(), { collateral: { volMultiplier: 2 } }); expect(b.value.netting[0].imRequired).toBeCloseTo(2 * a.value.netting[0].imRequired, 9);
  });
  it('KNOWN ANSWER: repo margin call after price decline and haircut increase', () => {
    const rp = { repo: [{ borrower: 'HF', lender: 'DLR', collateralAsset: 'GB', collateralQty: 30, cashBorrowed: 2500, haircut: 0.05 }] };
    expect(runCollateral(rich(rp), { collateral: {} }).value.entityCalls.find((e) => e.id === 'HF')?.repo ?? 0).toBe(0);
    const a = runCollateral(rich(rp), { collateral: { priceShocks: { GB: 0.2 } } }); expect(a.value.entityCalls.find((e) => e.id === 'HF').repo).toBeCloseTo(2500 - 30 * 80 * 0.95, 8);
    const b = runCollateral(rich(rp), { collateral: { priceShocks: { GB: 0.2 }, haircutAdd: { GB: 0.05 } } }); expect(b.value.entityCalls.find((e) => e.id === 'HF').repo).toBeCloseTo(2500 - 30 * 80 * 0.9, 8);
  });
  it('collateral eligibility & substitution: IM top-ups use eligible securities before cash; cash-only eligibility uses cash', () => {
    const a = runCollateral(col({ nettingSets: [{ id: 'N', party: 'HF', ccp: 'CCP1', positions: [{ asset: 'EQ', exposure: 2000 }], imPosted: 0 }] }), { collateral: {} });
    const w = a.value.work; expect(Object.keys(w.ns[0].posted)).toContain('GB'); expect(w.cash[0]).toBeCloseTo(200 - (w.ns[0].postedCash), 6);
    const b = runCollateral(col({ eligibility: { CCP: ['CASH'], BILATERAL: ['CASH'] }, nettingSets: [{ id: 'N', party: 'HF', ccp: 'CCP1', positions: [{ asset: 'EQ', exposure: 2000 }], imPosted: 0 }] }), { collateral: {} });
    expect(Object.keys(b.value.work.ns[0].posted)).toEqual([]);
  });
  it('closed-form expected positive exposure equals independent numerical integration; wrong-way multiplier ordering', () => {
    for (const [a, b] of [[0, 1], [-1.5, 1], [200, 100], [-300, 100]]) expect(expectedPositiveExposure(a, b)).toBeCloseTo(pySys('epe', { a, b }), 6);
    const a = -50; const b = 40; const base = 0.6 * 0.02 * expectedPositiveExposure(a, b);
    expect(wrongWayExpectedLoss(a, b, 0.02, 0.6, 0)).toBeCloseTo(base, 12); expect(wrongWayExpectedLoss(a, b, 0.02, 0.6, 0.5)).toBeGreaterThan(base); expect(wrongWayExpectedLoss(a, b, 0.02, 0.6, -0.5)).toBeLessThan(base);
    expect(wrongWayExpectedLoss(a, b, 0.02, 0.6, 0.5)).toBeCloseTo(pySys('wwr_el', { a, b, pd: 0.02, lgd: 0.6, rho: 0.5 }), 6);
    const r = runCollateral(col(), { collateral: {} }); expect(r.value.counterpartyExposure[0].wrongWayMultiplier).toBeGreaterThan(1);
  });
  it('margin-loan calls reuse M06 marginSaleRequired; margin default is flagged with unmet amount', () => {
    const s = col(); s.entities[0].leverage = { debt: 4000, marginRatio: 0.3 }; const ga = 200 + 50 * 100 + 20 * 100; const need = marginSaleRequired({ grossAssets: ga, debt: 4000, marginRatio: 0.3 });
    const r = runCollateral(s, { collateral: {} }); expect(r.value.entityCalls.find((e) => e.id === 'HF').marginLoan).toBeCloseTo(Math.min(need, 4000), 6);
    const t = col(); t.entities[0].cash = 0; t.entities[0].holdings = [{ asset: 'GB', shares: 1 }]; const d = runCollateral(t, { collateral: { priceShocks: { EQ: 0.5 } } });
    expect(d.value.defaultedEntities).toContain('HF'); expect(d.value.totals.unmet).toBeGreaterThan(0);
  });
  it('PROPERTY: calls non-negative, encumbered <= held, cash >= 0, calls monotone in shock; deterministic; input not mutated', () => {
    const s = makeSystem(2); const h = hashOf(s); let prev = -1;
    for (const k of [0, 0.05, 0.1, 0.2]) { const r = runCollateral(s, { collateral: { priceShocks: { EQ1: k, EQ2: k, GB: k / 2 }, volMultiplier: 1 + k } }); const w = r.value.work; w.cash.forEach((c) => expect(c).toBeGreaterThanOrEqual(-1e-6)); w.enc.forEach((row, i) => row.forEach((e, kx) => expect(e).toBeLessThanOrEqual(w.q[i][kx] + 1e-9)));
      r.value.entityCalls.forEach((c) => { expect(c.vm).toBeGreaterThanOrEqual(0); expect(c.im).toBeGreaterThanOrEqual(0); }); expect(r.value.totals.margin).toBeGreaterThanOrEqual(prev - 1e-6); prev = r.value.totals.margin; }
    const a = runCollateral(s, { collateral: { priceShocks: { EQ1: 0.1 } } }, { seed: 1 }); const b = runCollateral(s, { collateral: { priceShocks: { EQ1: 0.1 } } }, { seed: 1 }); expect(a.result_hash).toBe(b.result_hash); expect(hashOf(s)).toBe(h);
  });
  it('MISSING DATA: unobserved IM posted / counterparty PD flagged; missing sigma fails loudly', () => {
    const r = runCollateral(col({ nettingSets: [{ id: 'NS1', party: 'HF', counterparty: 'DLR', positions: [{ asset: 'EQ', exposure: 5000 }] }], wwr: { DLR: { pd: null, rho: 0.2 } } }), { collateral: {} });
    expect(r.unobserved).toContain('im_posted:NS1'); expect(r.unobserved).toContain('counterparty_pd:DLR'); expect(r.status).toBe('INSUFFICIENT_OBSERVABILITY'); expect(r.value.counterpartyExposure[0].wrongWayEL).toBeNull();
    const s = col(); s.assets[0].sigma = null; expect(runCollateral(s, { collateral: {} }).error).toMatch(/sigma/); expect(runCollateral(col({ mporDays: 0 }), { collateral: {} }).error).toMatch(/mporDays/);
    const u = col(); u.assets[0].illiq = null; u.entities[0].cash = 0; expect(runCollateral(u, { collateral: { priceShocks: { EQ: 0.3 } } }).unobserved.some((x) => x.startsWith('impact_inputs'))).toBe(true);
  });
});

describe('M64 CCP default waterfall', () => {
  const ccpSys = (over = {}) => ({
    assets: [{ id: 'EQ', price: 100, illiq: 0, sigma: 0.02 }], impact: { model: 'amihud-linear' },
    entities: [ent('CCP1', 'CCP'), ent('M1', 'BANK'), ent('M2', 'BANK'), ent('M3', 'BANK')],
    ccps: [{ id: 'CCP1', skinInTheGame: 10, assessmentCap: 1, members: [{ entity: 'M1', im: 30, dfContribution: 20, capital: 100, positions: [{ asset: 'EQ', exposure: 1000 }] }, { entity: 'M2', im: 10, dfContribution: 15, capital: 100, positions: [] }, { entity: 'M3', im: 10, dfContribution: 15, capital: 100, positions: [] }], ...over }],
  });
  it('KNOWN ANSWER: loss 100 -> IM 30, defaulter DF 20, SITG 10, survivor DF 30, assessments 10, unfunded 0 (hand + Python)', () => {
    const r = runCcp(ccpSys(), { ccp: { priceShocks: { EQ: 0.1 }, defaulters: ['M1'] } }); const L = r.value.ccps[0].finalLayers;
    expect(L.totalLoss).toBeCloseTo(100, 10); expect([L.defaulterIM, L.defaulterDF, L.skinInTheGame, L.survivorDF, L.assessments, L.unfunded]).toEqual([30, 20, 10, 30, 10, 0].map((x) => expect.closeTo(x, 10)));
    const ref = pySys('waterfall', { loss: 100, im: 30, df_def: 20, sitg: 10, survivors: [15, 15], cap_mult: 1 }); expect(L.survivorDF).toBeCloseTo(ref.df_survivors, 10); expect(L.assessments).toBeCloseTo(ref.assessments, 10); expect(L.unfunded).toBeCloseTo(ref.unfunded, 10);
    expect(r.value.ccps[0].memberCharges.M2).toBeCloseTo(15 + 5, 10); expect(r.value.ccps[0].memberCharges.M3).toBeCloseTo(20, 10);
  });
  it('survivor default propagation: a survivor whose charge exceeds its capital becomes a defaulter in the next round', () => {
    const s = ccpSys(); s.ccps[0].members[1].capital = 12; const r = runCcp(s, { ccp: { priceShocks: { EQ: 0.1 }, defaulters: ['M1'] } });
    expect(r.value.ccps[0].propagatedDefaults).toContain('M2'); expect(r.value.ccps[0].rounds.length).toBeGreaterThanOrEqual(2);
  });
  it('unfunded loss when the loss exceeds all layers; cover-2 test and IM concentration are reported', () => {
    const r = runCcp(ccpSys(), { ccp: { priceShocks: { EQ: 0.3 }, defaulters: ['M1'] } }); expect(r.value.ccps[0].finalLayers.unfunded).toBeCloseTo(300 - 30 - 20 - 10 - 30 - 30, 8);
    const c = r.value.ccps[0].concentration; expect(c.memberIm.hhi).toBeCloseTo((30 / 50) ** 2 + 2 * (10 / 50) ** 2, 10); expect(c.cover2Satisfied).toBe(false); expect(c.cover2Ratio).toBeLessThan(1);
  });
  it('PROPERTY: layers are used in order, sum to loss, and survivor charges are non-decreasing in the price shock', () => {
    let prev = -1;
    for (const k of [0, 0.02, 0.05, 0.1, 0.2, 0.4]) { const r = runCcp(ccpSys(), { ccp: { priceShocks: { EQ: k }, defaulters: ['M1'] } }); const L = r.value.ccps[0].finalLayers; expect(L.defaulterIM + L.defaulterDF + L.skinInTheGame + L.survivorDF + L.assessments + L.unfunded).toBeCloseTo(L.totalLoss, 8);
      if (L.defaulterDF > 0) expect(L.defaulterIM).toBeCloseTo(30, 8); if (L.survivorDF > 0) expect(L.skinInTheGame).toBeCloseTo(10, 8); expect(L.survivorDF + L.assessments).toBeGreaterThanOrEqual(prev - 1e-9); prev = L.survivorDF + L.assessments; }
  });
  it('MISSING DATA: unobserved assessment cap / member capital / impact parameters are flagged, not assumed', () => {
    const s = ccpSys(); s.ccps[0].assessmentCap = null; s.ccps[0].members[2].capital = null; const r = runCcp(s, { ccp: { priceShocks: { EQ: 0.3 }, defaulters: ['M1'] } });
    expect(r.unobserved).toContain('ccp_assessment_cap:CCP1'); expect(r.unobserved).toContain('ccp_member_capital:M3'); expect(r.status).toBe('INSUFFICIENT_OBSERVABILITY');
    const t = ccpSys(); t.assets[0].illiq = null; expect(runCcp(t, { ccp: { priceShocks: { EQ: 0.1 }, defaulters: ['M1'] } }).unobserved.some((x) => x.startsWith('ccp_closeout_impact'))).toBe(true);
  });
  it('fails loudly (non-CCP entity, unknown defaulter) and is deterministic', () => {
    const s = ccpSys(); s.entities[0].sector = 'BANK'; expect(runCcp(s, {}).error).toMatch(/sector CCP/); expect(runCcp(ccpSys(), { ccp: { defaulters: ['ZZ'] } }).error).toMatch(/unknown entity/);
    const a = runCcp(ccpSys(), { ccp: { priceShocks: { EQ: 0.1 }, defaulters: ['M1'] } }, { seed: 2 }); const b = runCcp(ccpSys(), { ccp: { priceShocks: { EQ: 0.1 }, defaulters: ['M1'] } }, { seed: 2 }); expect(a.result_hash).toBe(b.result_hash);
  });
});
