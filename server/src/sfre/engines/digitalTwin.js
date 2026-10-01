import { runCascade } from './cascade.js';
import { deepClone, deepFreeze, hashOf } from '../core/canonical.js';

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
