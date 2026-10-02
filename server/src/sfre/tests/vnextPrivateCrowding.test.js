import { describe, it, expect } from 'vitest';
import { runPrivateCredit, analyticLoss } from '../engines/systemic/privateCredit.js';
import { runAiCrowding, effectiveIndependent } from '../engines/systemic/crowding.js';
import { hashOf } from '../core/canonical.js';
import { Rng } from '../core/prng.js';
import { makeSystem, ent, pySys } from './vnextFixtures.js';

const pcSys = ({ pd = 0.04, debt = 100, cov = 0.45, rhoS = 0.2, gate = 0.05, extra = {} } = {}) => ({
  entities: [
    ent('PCF', 'PRIVATE_CREDIT', { cash: 20, creditBook: Array.from({ length: 20 }, (_, i) => ({ id: `L${i}`, amount: 10, pd, lgd: 0.5, riskSector: 'CORPORATE', sponsor: `S${i % 4}` })) }),
    ent('BANK', 'BANK', { cash: 50, externalAssets: 500, externalLiabilities: 400 + (100 - debt) }), ent('INS', 'INSURER', { cash: 10, externalAssets: 100, externalLiabilities: 60 }),
  ],
  exposures: [{ creditor: 'BANK', debtor: 'PCF', amount: debt }],
  privateCredit: { factor: { rhoGlobal: 0.2, rhoSponsor: rhoS }, funds: [{ entity: 'PCF', facilityLimit: 130, ltvCovenant: cov, unfundedCommitments: 20, gateFraction: gate, investors: [{ investor: 'INS', stake: 0.5 }], ...extra }] },
});

describe('M65 private credit / shadow banking', () => {
  it('KNOWN ANSWER: analytic stressed loss = sum EAD*LGD*Vasicek(pd, rho, g) (independent Python Vasicek)', () => {
    const g = -2.5; const r = runPrivateCredit(pcSys({ debt: 0 }), { privateCredit: { stressFactor: g, nSim: 200 } });
    expect(r.value.funds[0].creditLoss).toBeCloseTo(20 * 10 * 0.5 * pySys('vasicek', { pd: 0.04, rho: 0.2, g }), 9);
    const loans = pcSys().entities[0].creditBook; expect(analyticLoss(loans, 0.2, g).loss).toBeCloseTo(r.value.funds[0].creditLoss, 9);
  });
  it('seeded Monte Carlo mean is statistically consistent with the analytic mean (<= 4 s.e.) and sponsor clustering fattens the tail', () => {
    const lo = runPrivateCredit(pcSys({ rhoS: 0 }), { privateCredit: { stressFactor: -2, nSim: 6000 } }).value.funds[0].stressedLossDistribution; const hi = runPrivateCredit(pcSys({ rhoS: 0.3 }), { privateCredit: { stressFactor: -2, nSim: 6000 } }).value.funds[0].stressedLossDistribution;
    for (const d of [lo, hi]) expect(Math.abs(d.mean - d.analyticMean)).toBeLessThan(4 * d.se + 1e-9); expect(hi.p95).toBeGreaterThanOrEqual(lo.p95);
  });
  it('KNOWN ANSWER: LTV covenant deleveraging repay = (D - cov*A)/(1 - cov/(1-delta)) (Python) and realised loss', () => {
    const r = runPrivateCredit(pcSys({ pd: 0, debt: 120, cov: 0.45, extra: { gateFraction: 0.5 } }), { privateCredit: { stressFactor: 0, nSim: 100, liquidationDiscount: 0.15 } }); const f = r.value.funds[0];
    const rep = pySys('covenant_repay', { debt: 120, assets: 220, cov: 0.45, delta: 0.15 }); expect(f.covenant.breached).toBe(true); expect(f.covenant.repay).toBeCloseTo(rep, 9); expect(f.liquidationLoss).toBeCloseTo(rep * 0.15 / 0.85, 8); expect(f.debtFinal).toBeCloseTo(120 - rep, 8);
  });
  it('liquidity mismatch: redemptions are gated, unfunded draws consume liquidity, loans are sold at a discount when liquidity is short', () => {
    const base = pcSys({ pd: 0, debt: 60, cov: 0.9, gate: 0.1, extra: { facilityLimit: 60 } }); base.entities[0].cash = 5;
    const r = runPrivateCredit(base, { privateCredit: { stressFactor: 0, nSim: 100, redemptionFractions: { PCF: 0.5 }, unfundedDrawRate: 1, liquidationDiscount: 0.2 } }); const f = r.value.funds[0];
    const nav = 5 + 200 - 60; expect(f.redemption.requested).toBeCloseTo(0.5 * nav, 8); expect(f.redemption.payable).toBeCloseTo(0.1 * nav, 8); expect(f.redemption.gated).toBeCloseTo(0.4 * nav, 8); expect(f.redemption.unfundedDraw).toBeCloseTo(20, 8); expect(f.redemption.loansSold).toBeGreaterThan(0); expect(f.liquidationLoss).toBeGreaterThan(0);
    expect(r.value.handoff.investorInflowLost.INS).toBeCloseTo(0.5 * f.redemption.gated, 8);
  });
  it('transmission: insurer stake loss = stake x equity loss; lenders\' claims shrink after covenant repayment; identity reconciles', () => {
    const r = runPrivateCredit(pcSys({ debt: 120 }), { privateCredit: { stressFactor: -2.5, nSim: 100 } }); const f = r.value.funds[0]; expect(r.value.contagion.system.reconciled).toBe(true);
    expect(r.value.handoff.extAssetsDelta[2]).toBeCloseTo(-0.5 * f.equityLoss, 8); expect(r.value.handoff.edgeAmounts[0]).toBeCloseTo(f.debtFinal, 8);
    expect(f.concentration.sponsor.nEff).toBeCloseTo(4, 9); expect(f.concentration.borrower.hhi).toBeCloseTo(0.05, 12);
  });
  it('PROPERTY: stressed loss monotone in the stress factor; larger redemptions never reduce gating or sales', () => {
    let prev = -1; for (const g of [1, 0, -1, -2, -3]) { const l = runPrivateCredit(pcSys(), { privateCredit: { stressFactor: g, nSim: 100 } }).value.funds[0].creditLoss; expect(l).toBeGreaterThan(prev); prev = l; }
    let pg = -1; for (const red of [0, 0.1, 0.3, 0.6]) { const f = runPrivateCredit(pcSys({ pd: 0.01 }), { privateCredit: { stressFactor: -1, nSim: 100, redemptionFractions: { PCF: red }, unfundedDrawRate: 0.5 } }).value.funds[0]; expect(f.redemption.gated + f.redemption.loansSold).toBeGreaterThanOrEqual(pg - 1e-9); pg = f.redemption.gated + f.redemption.loansSold; }
  });
  it('MISSING DATA: unobserved PD/LGD, gate, facility limit, covenant and commitments are flagged and excluded, never zero', () => {
    const s = pcSys({ extra: { gateFraction: null, facilityLimit: null, ltvCovenant: null, unfundedCommitments: null } }); s.entities[0].creditBook[0].pd = null; s.entities[0].creditBook[1].lgd = null;
    const r = runPrivateCredit(s, { privateCredit: { stressFactor: -2, nSim: 100, redemptionFractions: { PCF: 0.2 } } });
    for (const u of ['loan_inputs:L0', 'loan_inputs:L1', 'gate_fraction:PCF', 'facility_limit:PCF', 'ltv_covenant:PCF', 'unfunded_commitments:PCF']) expect(r.unobserved).toContain(u);
    expect(r.status).toBe('INSUFFICIENT_OBSERVABILITY'); expect(r.value.lowerBound).toBe(true);
    const full = runPrivateCredit(pcSys(), { privateCredit: { stressFactor: -2, nSim: 100 } }); expect(r.value.funds[0].creditLoss).toBeLessThan(full.value.funds[0].creditLoss);
  });
  it('fails loudly on invalid input; deterministic with Monte-Carlo uncertainty block', () => {
    expect(runPrivateCredit(pcSys(), { privateCredit: { stressFactor: 99 } }).status).toBe('COMPUTATION_FAILED'); expect(runPrivateCredit(pcSys({ extra: { investors: [{ investor: 'INS', stake: 0.7 }, { investor: 'BANK', stake: 0.5 }] } }), { privateCredit: { stressFactor: -1 } }).error).toMatch(/exceed/);
    const s = pcSys(); s.privateCredit.factor.rhoSponsor = 0.9; expect(runPrivateCredit(s, { privateCredit: { stressFactor: -1 } }).error).toMatch(/rho/); const t = pcSys(); t.entities[0].creditBook[0].sponsor = undefined; expect(runPrivateCredit(t, { privateCredit: { stressFactor: -1 } }).error).toMatch(/sponsor/);
    const sc = { privateCredit: { stressFactor: -2, nSim: 500 } }; const a = runPrivateCredit(pcSys(), sc, { seed: 3 }); const b = runPrivateCredit(pcSys(), sc, { seed: 3 }); const c = runPrivateCredit(pcSys(), sc, { seed: 4 });
    expect(a.result_hash).toBe(b.result_hash); expect(c.result_hash).not.toBe(a.result_hash); expect(a.uncertainty.method).toBe('SEEDED_MONTE_CARLO'); expect(a.uncertainty.perFund[0].ci95[0]).toBeLessThan(a.uncertainty.perFund[0].ci95[1]); expect(a.calibration).toBe('UNCALIBRATED');
  });
});

const crowdSys = (agents, signals = ['s1', 's2'], asset = {}) => ({ assets: [{ id: 'EQ', price: 10, illiq: 1e-6, advValue: 1e6, ...asset }], impact: { model: 'amihud-linear' }, entities: [ent('X', 'FUND')], crowding: { signals, agents } });
const ag = (id, loadings, o = {}) => ({ id, capital: 100, leverage: 3, modelId: 'M-A', dataVendors: ['V1'], loadings, assetWeights: { EQ: 1 }, stopLoss: null, ...o });

describe('M66 AI crowding / algorithmic herding', () => {
  it('KNOWN ANSWER: effective independent strategies (identical -> 1, orthogonal -> n, mixed -> 1.8) match the Jacobi-eigenvalue reference', () => {
    expect(effectiveIndependent([[1, 0], [1, 0], [1, 0]])).toBeCloseTo(1, 12); expect(effectiveIndependent([[1, 0, 0], [0, 1, 0], [0, 0, 1]])).toBeCloseTo(3, 12); expect(effectiveIndependent([[1, 0], [1, 0], [0, 1]])).toBeCloseTo(1.8, 12);
    const r = new Rng(9); for (let t = 0; t < 8; t++) { const n = 3 + r.int(5); const rows = Array.from({ length: n }, () => Array.from({ length: 4 }, () => r.normal())); const unit = rows.map((v) => { const nr = Math.sqrt(v.reduce((s, x) => s + x * x, 0)); return v.map((x) => x / nr); }); expect(effectiveIndependent(unit)).toBeCloseTo(pySys('n_eff', { rows }), 8); }
  });
  it('KNOWN ANSWER: N identical agents -> herding ratio sqrt(N); net flow -> linear (Amihud) impact exactly', () => {
    const r = runAiCrowding(crowdSys([ag('a', { s1: 1 }), ag('b', { s1: 1 }), ag('c', { s1: 1 }), ag('d', { s1: 1 })]), { crowding: { responseScale: 1, signalShocks: { s1: -0.5 } } });
    const row = r.value.round0[0]; expect(row.herdingRatio).toBeCloseTo(2, 12); expect(row.netFlow).toBeCloseTo(-4 * 300 * 0.5, 9); expect(row.impact).toBeCloseTo(-1e-6 * 600, 12); expect(row.independentImpact).toBeCloseTo(-1e-6 * Math.sqrt(4 * 150 ** 2), 12);
    expect(r.value.measures.effectiveIndependentStrategies).toBeCloseTo(1, 12); expect(r.value.measures.modelConcentration.hhi).toBeCloseTo(1, 12);
  });
  it('stop-loss deleveraging creates a cascade (multiplier > 1); unobserved stop-loss never cascades and is flagged (lower bound)', () => {
    const mk = (stop) => runAiCrowding(crowdSys(Array.from({ length: 4 }, (_, i) => ag(`a${i}`, { s1: 1 }, { stopLoss: stop })), ['s1'], { illiq: 4e-6 }), { crowding: { responseScale: 1, signalShocks: { s1: -0.5 } } });
    const a = mk(0.005); expect(a.value.cascadeMultiplier).toBeGreaterThan(1); expect(a.value.triggeredAgents.length).toBeGreaterThan(0);
    const b = mk(null); expect(b.value.cascadeMultiplier).toBeCloseTo(1, 12); expect(b.unobserved.some((x) => x.startsWith('stop_loss'))).toBe(true); expect(b.status).toBe('INSUFFICIENT_OBSERVABILITY');
  });
  it('PROPERTY: herding amplification >= 1 for same-sign flows; price move monotone in shock and response scale; diversified agents herd less', () => {
    let prev = -1; for (const sh of [0.1, 0.3, 0.6, 0.9]) { const r = runAiCrowding(crowdSys([ag('a', { s1: 1 }), ag('b', { s1: 0.8, s2: 0.3 }), ag('c', { s1: 1 })]), { crowding: { responseScale: 1, signalShocks: { s1: -sh } } }); expect(r.value.round0[0].herdingRatio).toBeGreaterThanOrEqual(1 - 1e-12); const m = Math.abs(r.value.priceMoves.EQ); expect(m).toBeGreaterThanOrEqual(prev); prev = m; }
    const same = runAiCrowding(crowdSys([ag('a', { s1: 1 }), ag('b', { s1: 1 })]), { crowding: { responseScale: 1, signalShocks: { s1: -0.3, s2: -0.3 } } }); const diff = runAiCrowding(crowdSys([ag('a', { s1: 1 }), ag('b', { s2: 1 })]), { crowding: { responseScale: 1, signalShocks: { s1: -0.3, s2: 0.3 } } });
    expect(same.value.measures.effectiveIndependentStrategies).toBeLessThan(diff.value.measures.effectiveIndependentStrategies); expect(Math.abs(same.value.priceMoves.EQ)).toBeGreaterThan(Math.abs(diff.value.priceMoves?.EQ ?? 0));
  });
  it('MISSING DATA: unobserved impact inputs are excluded (never zero impact); ADV null leaves liquidity consumption null', () => {
    const r = runAiCrowding(crowdSys([ag('a', { s1: 1 }), ag('b', { s1: 1 })], ['s1', 's2'], { illiq: null, advValue: null }), { crowding: { responseScale: 1, signalShocks: { s1: -0.5 } } });
    expect(r.unobserved).toContain('impact_inputs:EQ'); expect(r.status).toBe('INSUFFICIENT_OBSERVABILITY'); expect(r.value.priceMoves.EQ).toBeUndefined();
    const t = runAiCrowding(crowdSys([ag('a', { s1: 1 }), ag('b', { s1: 1 })], ['s1', 's2'], { advValue: null }), { crowding: { responseScale: 1, signalShocks: { s1: -0.5 } } }); expect(t.value.round0[0].liquidityConsumption).toBeNull();
  });
  it('fails loudly (zero loadings, bad weights, missing shocks); deterministic; uncertainty band present', () => {
    expect(runAiCrowding(crowdSys([ag('a', { s1: 0 }), ag('b', { s1: 1 })]), { crowding: { responseScale: 1, signalShocks: { s1: -1 } } }).error).toMatch(/zero loadings/);
    expect(runAiCrowding(crowdSys([ag('a', { s1: 1 }, { assetWeights: { EQ: 0.5 } }), ag('b', { s1: 1 })]), { crowding: { responseScale: 1, signalShocks: { s1: -1 } } }).error).toMatch(/sum \|assetWeights\|/);
    expect(runAiCrowding(crowdSys([ag('a', { s1: 1 }), ag('b', { s1: 1 })]), { crowding: { responseScale: 0, signalShocks: { s1: -1 } } }).error).toMatch(/responseScale/); expect(runAiCrowding(crowdSys([ag('a', { s1: 1 })]), {}).status).toBe('COMPUTATION_FAILED');
    const s = makeSystem(2); const sc = { crowding: { responseScale: 1, signalShocks: { momentum: -0.4 } } }; const h = hashOf(s); const a = runAiCrowding(s, sc, { seed: 1 }); const b = runAiCrowding(s, sc, { seed: 1 }); expect(a.result_hash).toBe(b.result_hash); expect(hashOf(s)).toBe(h); expect(a.uncertainty.method).toBe('LATIN_HYPERCUBE_ASSUMPTION_BAND');
  });
});
