import { runCascade } from './cascade.js';
import { deepClone, deepFreeze, hashOf } from '../core/canonical.js';
import { simulateSystem, validateTwin } from './systemic/twin.js';

/**
 * Financial Digital Twin: STATE(t0) -> SHOCK -> RESPONSE -> LIQUIDATION -> MARKET IMPACT -> CONTAGION -> STATE(t+n).
 * The snapshot is deep-frozen at construction and re-hashed after every run:
 * historical data can never be modified by a simulation.
 */
export class FinancialDigitalTwin {
  #system; #hash;

  constructor(system) {
    this.#system = deepFreeze(deepClone(system));
    this.#hash = hashOf(this.#system);
  }

  get snapshotHash() { return this.#hash; }
  get system() { return this.#system; }

  assertSnapshotUnchanged() {
    const now = hashOf(this.#system);
    if (now !== this.#hash) throw new Error('digital twin snapshot was mutated');
    return true;
  }

  /** Runs one scenario on copies; returns the cascade result plus a per-step trajectory. */
  run(scenario, options = {}) {
    this.assertSnapshotUnchanged();
    const res = runCascade(this.#system, scenario, options);
    this.assertSnapshotUnchanged();
    if (!res.value) return { result: res, trajectory: null, stages: null };
    const v = res.value;
    const nav = Object.fromEntries(v.funds.map((f) => [f.id, f.nav0]));
    const prices = Object.fromEntries(this.#system.assets.map((a) => [a.id, a.price]));
    const trajectory = [{ t: 0, label: 'STATE(t0)', prices: { ...prices }, nav: { ...nav } }];
    // after the shock the direct loss is in nav; subsequent steps subtract per-round loss and paid-out redemptions
    const direct = Object.fromEntries(v.funds.map((f) => [f.id, f.byWho.direct]));
    const cur = { ...nav };
    for (const f of v.funds) cur[f.id] -= direct[f.id];
    v.rounds.forEach((rd, idx) => {
      const px = {}; this.#system.assets.forEach((a, k) => { px[a.id] = rd.prices ? rd.prices[k] : a.price; });
      for (const f of v.funds) {
        const d = rd.demand[f.id];
        cur[f.id] -= (d ? d.cashUsed + d.shortfall : 0) + (rd.loss[f.id] || 0);
      }
      trajectory.push({ t: idx + 1, label: idx === v.rounds.length - 1 ? 'STATE(t+n)' : `STATE(t+${idx + 1})`, prices: px, nav: { ...cur } });
    });
    const sum = (o) => Object.values(o).reduce((s, x) => s + x, 0);
    const stages = [
      { stage: 'STATE(t0)', funds: v.funds.length },
      { stage: 'SHOCK', directLoss: v.system.byWho.direct },
      { stage: 'RESPONSE', redemptionsDemanded: v.rounds.reduce((s, r) => s + sum(Object.fromEntries(Object.entries(r.demand).map(([k, x]) => [k, x.demand]))), 0) },
      { stage: 'LIQUIDATION', forcedSales: v.system.totalForcedSales },
      { stage: 'MARKET_IMPACT', selfImpact: v.system.byWho.selfImpact },
      { stage: 'CONTAGION', commonAsset: v.system.byWho.commonAsset, counterparty: v.system.byWho.counterparty, rounds: v.rounds.length },
      { stage: 'STATE(t+n)', totalLoss: v.system.totalLoss },
    ];
    return { result: res, trajectory, stages };
  }
}

/**
 * Financial SYSTEM Digital Twin: extends the fund-level twin (unchanged, still available through run()) with the whole
 * financial system -- banks, funds, insurers, corporates, sovereign, households, foreign investors, CCPs, private credit,
 * stablecoin/DeFi -- on one balance-sheet/exposure network:
 *   SHOCK -> BALANCE-SHEET EFFECT -> FUNDING/LIQUIDITY -> MARGIN/COLLATERAL -> FORCED ACTION -> MARKET IMPACT
 *   -> COUNTERPARTY/NETWORK CONTAGION -> SECOND-ROUND EFFECTS -> STATE(t+n)
 * The system snapshot is deep-frozen and re-hashed around every run exactly like the fund snapshot.
 * An optional `fundSystem` keeps running through the existing M10 cascade, coupled through the shared price vector.
 */
export class FinancialSystemDigitalTwin extends FinancialDigitalTwin {
  #sys; #sysHash;

  constructor({ system, fundSystem = null }) {
    super(fundSystem ?? { assets: [], funds: [], impact: system?.impact });
    this.#sys = deepFreeze(deepClone(system));
    this.#sysHash = hashOf(this.#sys);
  }

  get systemSnapshotHash() { return this.#sysHash; }
  get systemState() { return this.#sys; }

  assertSnapshotUnchanged() {
    super.assertSnapshotUnchanged();
    if (hashOf(this.#sys) !== this.#sysHash) throw new Error('financial system twin snapshot was mutated');
    return true;
  }

  /** Full multi-engine simulation. Throws {code:'INVALID_REQUEST'} on invalid input (fail loudly). */
  runSystem(scenario = {}, options = {}) {
    this.assertSnapshotUnchanged();
    const funds = this.system.funds.length ? this.system : null;
    const err = validateTwin(this.#sys, scenario, options, funds);
    if (err) throw Object.assign(new Error(err), { code: 'INVALID_REQUEST' });
    const out = simulateSystem(this.#sys, scenario, options, funds);
    this.assertSnapshotUnchanged();
    return out;
  }
}
