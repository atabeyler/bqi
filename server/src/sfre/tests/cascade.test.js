import { describe, it, expect } from 'vitest';
import { runCascade, systemLossFraction } from '../engines/cascade.js';
import { FinancialDigitalTwin } from '../engines/digitalTwin.js';
import { counterfactuals, disjointify } from '../engines/counterfactual.js';
import { deepClone, hashOf } from '../core/canonical.js';
import { randomSystem } from './helpers.js';

const twoFund = () => ({
  assets: [{ id: 'A', price: 10, illiq: 1e-8 }],
  impact: { model: 'amihud-linear' },
  funds: [
    { id: 'F1', cash: 1e6, debt: 0, marginRatio: 0.2, beta: null, holdings: [{ asset: 'A', shares: 2e6 }] },
    { id: 'F2', cash: 1e6, debt: 0, marginRatio: 0.2, beta: null, holdings: [{ asset: 'A', shares: 2e6 }] },
  ],
});

describe('cascade: known answers', () => {
  it('single fund, one round, matches the closed-form (independent python-style) calculation', () => {
    const sys = { assets: [{ id: 'A', price: 10, illiq: 1e-8 }], impact: { model: 'amihud-linear' }, funds: [{ id: 'F', cash: 1e6, debt: 0, marginRatio: null, beta: null, holdings: [{ asset: 'A', shares: 2e6 }] }] };
    const r = runCascade(sys, { redemptions: { F: 3e6 } });
    // cash 1e6 used, shortfall 2e6 sold (pro-rata, one asset), d = 1e-8 * 2e6 = 0.02, remaining shares = 2e6 - 2e5 = 1.8e6, loss = 1.8e6*10*0.02 = 3.6e5
    const f = r.value.funds[0];
    expect(f.redemptionsPaid).toBeCloseTo(3e6, 6); expect(f.loss).toBeCloseTo(3.6e5, 4);
    expect(f.byWhy.liquidity).toBeCloseTo(3.6e5, 4); expect(f.byWho.selfImpact).toBeCloseTo(3.6e5, 4);
    expect(f.identityResidual).toBeCloseTo(0, 6);
  });
  it('direct shock only: loss = q*p*s, no forced sales when no redemptions', () => {
    const r = runCascade(twoFund(), { priceShocks: { A: 0.1 } });
    expect(r.value.system.byWho.direct).toBeCloseTo(2 * 2e6 * 10 * 0.1, 6); expect(r.value.system.totalForcedSales).toBe(0); expect(r.value.system.converged).toBe(true);
  });
});

describe('cascade: structure & invariants', () => {
  it('two funds with common asset: the non-redeeming fund suffers common-asset contagion', () => {
    const r = runCascade(twoFund(), { redemptions: { F1: 5e6 } });
    const f2 = r.value.funds[1];
    expect(f2.byWho.commonAsset).toBeGreaterThan(0); expect(f2.byWho.selfImpact).toBe(0);
  });
  it('no overlap -> no cross-fund loss (common-asset contagion exactly 0)', () => {
    const sys = twoFund(); sys.assets.push({ id: 'B', price: 10, illiq: 1e-8 }); sys.funds[1].holdings = [{ asset: 'B', shares: 2e6 }];
    const r = runCascade(sys, { redemptions: { F1: 5e6 } });
    expect(r.value.funds[1].loss).toBe(0); expect(r.value.system.byWho.commonAsset).toBe(0);
  });
  it('PROPERTY: both decompositions reconcile to total loss, NAV identity holds, for random systems', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const sys = randomSystem(seed); const shocks = { A0: 0.05 + 0.002 * seed, A3: 0.03 };
      const r = runCascade(sys, { priceShocks: shocks, redemptions: { F0: { fraction: 0.4 }, F2: { fraction: 0.25 } } });
      expect(r.value, `seed ${seed}`).not.toBeNull();
      const rc = r.value.system.reconciliation;
      expect(Math.abs(rc.residualWho)).toBeLessThanOrEqual(rc.tolerance); expect(Math.abs(rc.residualWhy)).toBeLessThanOrEqual(rc.tolerance); expect(rc.maxIdentityResidual).toBeLessThanOrEqual(rc.tolerance);
      expect(r.value.system.reconciled).toBe(true);
      const s = r.value.system; const whySum = s.byWhy.direct + s.byWhy.liquidity + s.byWhy.redemption + s.byWhy.margin + s.byWhy.counterparty;
      expect(whySum).toBeCloseTo(s.totalLoss, 3);
    }
  });
  it('PROPERTY: loss is monotone non-decreasing in the shock size', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const sys = randomSystem(seed, { withClaims: false }); let prev = -1;
      for (const s of [0, 0.05, 0.1, 0.2, 0.4]) { const l = systemLossFraction(runCascade(sys, { priceShocks: { A1: s, A2: s }, redemptions: { F1: { fraction: s } } })); expect(l).toBeGreaterThanOrEqual(prev - 1e-12); prev = l; }
    }
  });
  it('is deterministic and does not mutate its input', () => {
    const sys = randomSystem(5); const before = hashOf(sys);
    const a = runCascade(sys, { priceShocks: { A0: 0.1 }, redemptions: { F0: { fraction: 0.3 } } }); const b = runCascade(sys, { priceShocks: { A0: 0.1 }, redemptions: { F0: { fraction: 0.3 } } });
    expect(hashOf(sys)).toBe(before); expect(a.result_hash).toBe(b.result_hash);
  });
  it('waterfall vs pro-rata both reconcile and differ', () => {
    const sys = randomSystem(8); sys.assets.forEach((a, k) => { a.advValue = 1e6 * (k + 1); });
    const p = runCascade(sys, { redemptions: { F0: { fraction: 0.5 } } }, { policy: 'pro-rata' }); const w = runCascade(sys, { redemptions: { F0: { fraction: 0.5 } } }, { policy: 'waterfall' });
    expect(p.value.system.reconciled && w.value.system.reconciled).toBe(true); expect(p.value.system.totalLoss).not.toBe(w.value.system.totalLoss);
  });
});

describe('cascade: channels & unobserved data', () => {
  it('REGRESSION: missing debt is not zero debt -> no margin sales, channel listed, result flagged as lower bound', () => {
    const sys = twoFund(); sys.funds[0].debt = null; sys.funds[0].marginRatio = 0.5;
    const r = runCascade(sys, { priceShocks: { A: 0.3 } });
    expect(r.status).toBe('INSUFFICIENT_OBSERVABILITY'); expect(r.unobserved).toContain('debt:F1'); expect(r.value.lowerBound).toBe(true);
    expect(r.value.funds[0].byWhy.margin).toBe(0); expect(r.value.funds[0].navBasis).toBe('GROSS_OF_UNOBSERVED_DEBT');
  });
  it('margin channel: leveraged fund deleverages after a shock and this generates MARGIN-tagged loss', () => {
    const sys = twoFund(); sys.funds[0].debt = 2e7; sys.funds[0].holdings = [{ asset: 'A', shares: 2.4e6 }]; sys.funds[0].cash = 2e5;
    const r = runCascade(sys, { priceShocks: { A: 0.1 } });
    expect(r.value.funds[0].byWhy.margin + r.value.funds[1].byWhy.margin).toBeGreaterThan(0);
    const off = runCascade(sys, { priceShocks: { A: 0.1 } }, { channels: { margin: false } });
    expect(off.value.system.totalLoss).toBeLessThan(r.value.system.totalLoss);
  });
  it('secondary redemption: unobserved beta excluded and listed; observed beta increases loss', () => {
    const none = twoFund(); const withBeta = twoFund(); withBeta.funds.forEach((f) => { f.beta = 0.8; });
    const a = runCascade(none, { redemptions: { F1: 4e6 } }); const b = runCascade(withBeta, { redemptions: { F1: 4e6 } });
    expect(a.unobserved).toContain('beta_redemption:F1'); expect(b.value.system.totalLoss).toBeGreaterThan(a.value.system.totalLoss); expect(b.value.system.byWhy.redemption).toBeGreaterThan(0);
  });
  it('counterparty: a failing debtor causes a writedown tagged COUNTERPARTY; recovery is endogenous (<=1)', () => {
    const sys = { assets: [{ id: 'A', price: 10, illiq: 1e-9 }], impact: { model: 'amihud-linear' }, funds: [
      { id: 'CRED', cash: 1e6, debt: 0, marginRatio: null, beta: null, holdings: [], claims: [{ counterparty: 'DEBT', amount: 4e6 }] },
      { id: 'DEBT', cash: 0, debt: 5e6, marginRatio: null, beta: null, holdings: [{ asset: 'A', shares: 4e5 }] },
    ] };
    const r = runCascade(sys, { priceShocks: { A: 0.5 } });
    expect(r.value.funds[1].failed).toBe(true); expect(r.value.system.byWho.counterparty).toBeGreaterThan(0); expect(r.value.system.byWho.counterparty).toBeLessThanOrEqual(4e6);
    expect(r.value.system.reconciled).toBe(true);
    const off = runCascade(sys, { priceShocks: { A: 0.5 } }, { channels: { counterparty: false } });
    expect(off.value.system.byWho.counterparty).toBe(0);
  });
  it('REGRESSION: a zero-debt, zero-asset fund is not declared failed', () => {
    const sys = twoFund(); sys.funds.push({ id: 'EMPTY', cash: 0, debt: 0, marginRatio: 0.2, beta: null, holdings: [] });
    expect(runCascade(sys, { priceShocks: { A: 0.2 } }).value.funds[2].failed).toBe(false);
  });
  it('unobserved impact inputs: reported as a lower bound, not assumed zero silently', () => {
    const sys = twoFund(); sys.assets[0].illiq = null;
    const r = runCascade(sys, { redemptions: { F1: 5e6 } });
    expect(r.status).toBe('INSUFFICIENT_OBSERVABILITY'); expect(r.unobserved).toContain('impact_inputs:A'); expect(r.value.lowerBound).toBe(true);
  });
  it('non-convergence is reported as MODEL_UNCERTAIN, never silently truncated', () => {
    const sys = twoFund(); sys.funds.forEach((f) => { f.beta = 1.5; f.cash = 0; });
    const r = runCascade(sys, { priceShocks: { A: 0.2 }, redemptions: { F1: 2e6 } }, { maxRounds: 1 });
    expect(r.status).toBe('MODEL_UNCERTAIN'); expect(r.value.system.converged).toBe(false);
  });
});

describe('cascade: failure injection', () => {
  it('invalid systems and scenarios return COMPUTATION_FAILED (never throw / never NaN)', () => {
    expect(runCascade({}, {}).status).toBe('COMPUTATION_FAILED');
    const sys = twoFund(); sys.assets[0].price = -1; expect(runCascade(sys, {}).status).toBe('COMPUTATION_FAILED');
    expect(runCascade(twoFund(), { priceShocks: { A: 1.5 } }).status).toBe('COMPUTATION_FAILED');
    expect(runCascade(twoFund(), { priceShocks: { ZZZ: 0.1 } }).status).toBe('COMPUTATION_FAILED');
    const s2 = twoFund(); s2.funds[0].holdings = [{ asset: 'NOPE', shares: 1 }]; expect(runCascade(s2, {}).status).toBe('COMPUTATION_FAILED');
    const s3 = twoFund(); s3.impact = { model: 'sqrt' }; expect(runCascade(s3, {}).status).toBe('COMPUTATION_FAILED'); // sqrt needs Y
  });
  it('extreme shock (100%) stays finite and reconciled', () => {
    const r = runCascade(randomSystem(3), { priceShocks: { A0: 1, A1: 1, A2: 1 }, redemptions: { F0: { fraction: 1 } } });
    expect(Number.isFinite(r.value.system.totalLoss)).toBe(true); expect(r.value.system.reconciled).toBe(true);
  });
});

describe('digital twin & counterfactuals', () => {
  it('snapshot is frozen, unchanged by runs, and trajectory runs t0 -> t+n', () => {
    const twin = new FinancialDigitalTwin(randomSystem(2)); const h = twin.snapshotHash;
    const out = twin.run({ priceShocks: { A0: 0.1 }, redemptions: { F0: { fraction: 0.3 } } });
    expect(twin.snapshotHash).toBe(h); expect(twin.assertSnapshotUnchanged()).toBe(true);
    expect(() => { twin.system.funds[0].cash = 0; }).toThrow();
    expect(out.trajectory[0].label).toBe('STATE(t0)'); expect(out.trajectory.at(-1).label).toBe('STATE(t+n)');
    expect(out.stages.map((s) => s.stage)).toEqual(['STATE(t0)', 'SHOCK', 'RESPONSE', 'LIQUIDATION', 'MARKET_IMPACT', 'CONTAGION', 'STATE(t+n)']);
    // final trajectory NAV equals the cascade's navFinal (conservation across the twin's reconstruction)
    for (const f of out.result.value.funds) expect(out.trajectory.at(-1).nav[f.id]).toBeCloseTo(f.navFinal, 3);
  });
  it('historical data cannot be altered by simulation (input object frozen copy)', () => {
    const sys = randomSystem(4); const twin = new FinancialDigitalTwin(sys); twin.run({ priceShocks: { A0: 0.3 } });
    expect(sys.assets[0].price).toBe(randomSystem(4).assets[0].price);
  });
  it('counterfactuals: switching off a channel never increases loss; disjointify removes common-asset contagion', () => {
    const sys = randomSystem(6); const sc = { priceShocks: { A0: 0.1 }, redemptions: { F0: { fraction: 0.4 } } };
    const cf = counterfactuals(sys, sc);
    expect(cf.value.variants.no_margin_channel.delta.lossFraction).toBeLessThanOrEqual(1e-12);
    expect(cf.value.variants.no_secondary_redemption.delta.lossFraction).toBeLessThanOrEqual(1e-12);
    expect(cf.value.variants.impact_halved.delta.lossFraction).toBeLessThanOrEqual(1e-12);
    expect(cf.notes.join(' ')).toMatch(/not causal identification/);
    const dj = runCascade(disjointify(deepClone(sys)), { redemptions: { F0: { fraction: 0.4 } } });
    expect(dj.value.system.byWho.commonAsset).toBe(0);
  });
});
