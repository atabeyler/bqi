import { makeResult, failed, STATUS, CALIBRATION } from '../core/result.js';
import { priceImpact, validateImpactModel } from './impact.js';
import { marginSaleRequired } from './leverage.js';
import { hashOf } from '../core/canonical.js';

const ENGINE = 'cascade';
export const EPS = 1e-9;
export const DEFAULT_MAX_ROUNDS = 50;
export const TRIGGERS = ['LIQUIDITY', 'REDEMPTION', 'MARGIN'];

/** Validates a FundSystem; returns an error string or null. */
export function validateSystem(system) {
  if (!system || !Array.isArray(system.assets) || !Array.isArray(system.funds)) return 'system.assets and system.funds required';
  const ids = new Set();
  for (const a of system.assets) {
    if (!a.id || ids.has(a.id)) return `duplicate/missing asset id ${a.id}`;
    ids.add(a.id);
    if (!(a.price > 0)) return `asset ${a.id}: price must be > 0`;
  }
  const fids = new Set();
  for (const f of system.funds) {
    if (!f.id || fids.has(f.id)) return `duplicate/missing fund id ${f.id}`;
    fids.add(f.id);
    if (!(f.cash >= 0)) return `fund ${f.id}: cash must be >= 0`;
    for (const h of f.holdings || []) {
      if (!ids.has(h.asset)) return `fund ${f.id}: unknown asset ${h.asset}`;
      if (!(h.shares >= 0)) return `fund ${f.id}: negative shares`;
    }
    for (const c of f.claims || []) if (c.amount !== null && c.amount !== undefined && !(c.amount >= 0)) return `fund ${f.id}: negative claim`;
    if (f.debt !== null && f.debt !== undefined && !(f.debt >= 0)) return `fund ${f.id}: negative debt`;
  }
  return validateImpactModel(system.impact);
}

function redemptionAmount(spec, nav0) {
  if (spec === undefined || spec === null) return 0;
  if (typeof spec === 'number') return spec; // TRY
  if (spec.amount !== undefined) return spec.amount;
  if (spec.fraction !== undefined) return spec.fraction * nav0;
  return 0;
}

/**
 * Iterative fire-sale / contagion cascade. Pure: never mutates `system`.
 * See MATHEMATICAL_SPECIFICATION M09/M10.
 */
export function runCascade(system, scenario = {}, options = {}) {
  const sysErr = validateSystem(system);
  if (sysErr) return failed(ENGINE, 'M10.cascade', sysErr);
  const opt = {
    policy: options.policy ?? 'pro-rata',
    maxRounds: options.maxRounds ?? DEFAULT_MAX_ROUNDS,
    channels: { margin: true, secondary: true, counterparty: true, ...(options.channels || {}) },
  };
  if (!['pro-rata', 'waterfall'].includes(opt.policy)) return failed(ENGINE, 'M10.cascade', 'policy must be pro-rata|waterfall');
  const shocks = scenario.priceShocks || {};
  for (const [k, s] of Object.entries(shocks)) if (!(s >= 0 && s <= 1)) return failed(ENGINE, 'M10.cascade', `price shock ${k} must be in [0,1]`);

  const A = system.assets; const F = system.funds;
  const nA = A.length; const nF = F.length;
  const aIdx = new Map(A.map((a, i) => [a.id, i]));
  const fIdx = new Map(F.map((f, i) => [f.id, i]));
  const price = A.map((a) => a.price);
  const q = F.map((f) => { const row = new Array(nA).fill(0); for (const h of f.holdings || []) row[aIdx.get(h.asset)] += h.shares; return row; });
  const cash = F.map((f) => f.cash);
  const debt = F.map((f) => (f.debt === null || f.debt === undefined ? null : f.debt));
  const margin = F.map((f) => (f.marginRatio === null || f.marginRatio === undefined ? null : f.marginRatio));
  const beta = F.map((f) => (f.beta === null || f.beta === undefined ? null : f.beta));
  // claims[i] = [{j, amount|null}]
  const claims = F.map((f) => (f.claims || []).map((c) => ({ j: fIdx.get(c.counterparty), amount: c.amount ?? null, id: c.counterparty })));
  const wd = new Array(nF).fill(0); // cumulative writedown fraction of claims ON fund j

  const unobservedChannels = new Set();
  const lowerBoundReasons = new Set();
  F.forEach((f, i) => {
    if (debt[i] === null) { unobservedChannels.add(`debt:${f.id}`); if (opt.channels.margin) lowerBoundReasons.add('margin channel excluded for funds with unobserved debt'); }
    else if (margin[i] === null && opt.channels.margin) unobservedChannels.add(`margin_ratio:${f.id}`);
    if (beta[i] === null && opt.channels.secondary) { unobservedChannels.add(`beta_redemption:${f.id}`); lowerBoundReasons.add('secondary redemption excluded for funds with unobserved sensitivity'); }
    claims[i].forEach((c) => { if (c.amount === null) { unobservedChannels.add(`claim:${f.id}->${c.id}`); lowerBoundReasons.add('counterparty claims with unobserved amount excluded'); } });
  });

  const claimsValue = (i) => claims[i].reduce((s, c) => s + (c.amount === null ? 0 : c.amount * (1 - wd[c.j])), 0);
  const GA = (i) => { let s = 0; for (let k = 0; k < nA; k++) s += q[i][k] * price[k]; return s; };
  const equity = (i) => cash[i] + GA(i) + claimsValue(i) - (debt[i] === null ? 0 : debt[i]);
  const navBasis = (i) => (debt[i] === null ? 'GROSS_OF_UNOBSERVED_DEBT' : 'EQUITY');

  // ---- round 0 shock (direct loss)
  // loss attribution accumulators per fund: [self|other] x [LIQUIDITY|REDEMPTION|MARGIN], plus counterparty
  const attr = F.map(() => ({ self: [0, 0, 0], other: [0, 0, 0], counterparty: 0 }));
  const TRIG = { LIQUIDITY: 0, REDEMPTION: 1, MARGIN: 2 };
  const direct = new Array(nF).fill(0);
  const nav0 = [];
  for (let i = 0; i < nF; i++) nav0.push(equity(i));
  for (const [id, s] of Object.entries(shocks)) {
    const k = aIdx.get(id);
    if (k === undefined) return failed(ENGINE, 'M10.cascade', `price shock on unknown asset ${id}`);
    for (let i = 0; i < nF; i++) direct[i] += q[i][k] * price[k] * s;
    price[k] *= 1 - s;
  }
  const loss = new Array(nF).fill(0); // total loss per fund
  for (let i = 0; i < nF; i++) loss[i] = direct[i];
  let lossPrevRound = direct.slice();
  const paid = new Array(nF).fill(0);
  const failedFlag = new Array(nF).fill(false);
  const exogenous = F.map((f, i) => Math.max(0, redemptionAmount(scenario.redemptions?.[f.id], nav0[i])));

  const rounds = [];
  let converged = false;
  const totalNav0 = nav0.reduce((s, x) => s + Math.abs(x), 0) || 1;
  let r = 0;
  for (; r < opt.maxRounds; r++) {
    const rec = { round: r, demand: {}, sold: {}, impact: {}, loss: {}, prices: null };
    const sold = [new Float64Array(nF * nA), new Float64Array(nF * nA), new Float64Array(nF * nA)]; // [trigger][i*nA+k] value sold at pre-impact marks
    let totalSold = 0;
    const roundLoss = new Array(nF).fill(0);

    for (let i = 0; i < nF; i++) {
      // 1) redemption demand
      let demand = r === 0 ? exogenous[i] : (opt.channels.secondary && beta[i] !== null ? beta[i] * lossPrevRound[i] : 0);
      const cap = Math.max(0, equity(i));
      if (demand > cap) demand = cap; // cannot pay out more than the fund is worth
      // 2) cash first, then forced liquidation
      const use = Math.min(cash[i], demand);
      cash[i] -= use;
      const shortfall = demand - use;
      paid[i] += use;
      const ga0 = GA(i);
      const S = Math.min(shortfall, ga0);
      // paid-by-sale accounted when executed
      let Amargin = 0;
      if (opt.channels.margin && debt[i] !== null && margin[i] !== null) {
        // state after redemption payout: gross assets ga0 - S, equity reduced by use+S already (cash used) -> recompute explicitly
        const gaAfter = ga0 - S;
        const eqAfter = cash[i] + gaAfter + claimsValue(i) - debt[i];
        Amargin = Math.min(gaAfter, marginSaleRequired({ grossAssets: gaAfter, debt: debt[i], marginRatio: margin[i] }) ?? 0);
        if (eqAfter <= 0) Amargin = gaAfter; // insolvent: everything liquidated toward creditors
      }
      rec.demand[F[i].id] = { demand, cashUsed: use, shortfall: S, marginSale: Amargin };
      const sellTotal = S + Amargin;
      if (!(sellTotal > 0)) continue;
      // allocate sales across assets
      const order = [];
      for (let k = 0; k < nA; k++) if (q[i][k] > 0) order.push(k);
      if (opt.policy === 'waterfall') {
        const key = (k) => (A[k].advValue > 0 ? (q[i][k] * price[k]) / A[k].advValue : Infinity);
        order.sort((x, y) => key(x) - key(y) || x - y);
      }
      const remainSale = sellTotal;
      const sellPerAsset = new Array(nA).fill(0); // value
      if (opt.policy === 'pro-rata') {
        for (const k of order) sellPerAsset[k] = (q[i][k] * price[k] / ga0) * remainSale;
      } else {
        let left = remainSale;
        for (const k of order) { const v = Math.min(left, q[i][k] * price[k]); sellPerAsset[k] = v; left -= v; if (left <= 0) break; }
      }
      const trigS = r === 0 ? 'LIQUIDITY' : 'REDEMPTION';
      for (const k of order) {
        const v = sellPerAsset[k];
        if (!(v > 0)) continue;
        const shares = Math.min(q[i][k], v / price[k]);
        q[i][k] -= shares;
        const valueSold = shares * price[k];
        if (S > 0) sold[TRIG[trigS]][i * nA + k] += valueSold * (S / sellTotal);
        if (Amargin > 0) sold[TRIG.MARGIN][i * nA + k] += valueSold * (Amargin / sellTotal);
        totalSold += valueSold;
      }
      paid[i] += S; // redemption proceeds leave the fund
      if (Amargin > 0) { const repay = Math.min(Amargin, debt[i]); debt[i] -= repay; cash[i] += Amargin - repay; } // margin proceeds repay debt; any surplus stays as cash
      rec.sold[F[i].id] = sellTotal;
    }

    if (r > 0 && totalSold <= EPS * totalNav0) { converged = true; rec.prices = price.slice(); rec.note = 'converged: no further forced sales'; rounds.push(rec); break; }

    // 3) aggregate market impact
    const Qk = new Array(nA).fill(0);
    for (let t = 0; t < 3; t++) for (let i = 0; i < nF; i++) for (let k = 0; k < nA; k++) Qk[k] += sold[t][i * nA + k];
    const d = new Array(nA).fill(0);
    for (let k = 0; k < nA; k++) {
      if (Qk[k] <= 0) continue;
      const imp = priceImpact(system.impact, A[k], Qk[k]);
      if (imp === null) { unobservedChannels.add(`impact_inputs:${A[k].id}`); lowerBoundReasons.add('price impact unobserved for sold assets: impact treated as unquantified (not as zero), totals are lower bounds'); d[k] = 0; } else d[k] = imp;
      rec.impact[A[k].id] = { Q: Qk[k], d: d[k] };
    }

    // 4) mark-to-market loss on remaining holdings, attributed to sale cells
    for (let k = 0; k < nA; k++) {
      if (!(d[k] > 0)) continue;
      const Q = Qk[k];
      const totT = [0, 1, 2].map((t) => { let tot = 0; for (let j = 0; j < nF; j++) tot += sold[t][j * nA + k]; return tot; });
      for (let i = 0; i < nF; i++) {
        const l = q[i][k] * price[k] * d[k];
        if (!(l > 0)) continue;
        roundLoss[i] += l;
        for (let t = 0; t < 3; t++) {
          const own = sold[t][i * nA + k] / Q; // share of this asset's sales that fund i itself made for trigger t
          attr[i].self[t] += l * own;
          attr[i].other[t] += l * (totT[t] / Q - own);
        }
      }
      price[k] *= 1 - d[k];
    }

    // 5) counterparty failures (only where debt observed)
    if (opt.channels.counterparty) {
      for (let j = 0; j < nF; j++) {
        if (debt[j] === null || !(debt[j] > 0)) continue;
        const assets = cash[j] + GA(j) + claimsValue(j);
        if (assets - debt[j] > 0) continue;
        failedFlag[j] = true;
        const recovery = debt[j] > 0 ? Math.min(1, Math.max(0, assets) / debt[j]) : 1;
        const newWd = Math.max(wd[j], 1 - recovery);
        const dw = newWd - wd[j];
        if (dw > 0) {
          for (let i = 0; i < nF; i++) {
            for (const c of claims[i]) if (c.j === j && c.amount !== null) {
              const l = c.amount * dw;
              roundLoss[i] += l;
              attr[i].counterparty += l;
            }
          }
          wd[j] = newWd;
        }
      }
    }
    for (let i = 0; i < nF; i++) { loss[i] += roundLoss[i]; rec.loss[F[i].id] = roundLoss[i]; }
    lossPrevRound = roundLoss;
    rec.prices = price.slice();
    rounds.push(rec);
  }

  // ---- reconciliation & decomposition
  const zero = () => ({ direct: 0, selfImpact: 0, commonAsset: 0, counterparty: 0 });
  const byWhy0 = () => ({ direct: 0, liquidity: 0, redemption: 0, margin: 0, counterparty: 0 });
  const sysWho = zero(); const sysWhy = byWhy0();
  const fundsOut = F.map((f, i) => {
    const who = zero(); const why = byWhy0();
    who.direct = direct[i]; why.direct = direct[i];
    who.selfImpact = attr[i].self.reduce((x, y) => x + y, 0); who.commonAsset = attr[i].other.reduce((x, y) => x + y, 0); who.counterparty = attr[i].counterparty;
    why.counterparty = attr[i].counterparty;
    ['liquidity', 'redemption', 'margin'].forEach((name, t) => { why[name] = attr[i].self[t] + attr[i].other[t]; });
    const navFinal = equity(i);
    const totalLoss = loss[i];
    for (const k of Object.keys(sysWho)) sysWho[k] += who[k];
    for (const k of Object.keys(sysWhy)) sysWhy[k] += why[k];
    return {
      id: f.id, navBasis: navBasis(i), nav0: nav0[i], navFinal, redemptionsPaid: paid[i], loss: totalLoss,
      byWho: who, byWhy: why,
      identityResidual: navFinal - (nav0[i] - paid[i] - totalLoss), failed: failedFlag[i],
    };
  });
  const totalLoss = fundsOut.reduce((s, x) => s + x.loss, 0);
  const sumWho = Object.values(sysWho).reduce((s, x) => s + x, 0);
  const sumWhy = Object.values(sysWhy).reduce((s, x) => s + x, 0);
  const reconciliation = {
    totalLoss, residualWho: totalLoss - sumWho, residualWhy: totalLoss - sumWhy,
    maxIdentityResidual: Math.max(0, ...fundsOut.map((f) => Math.abs(f.identityResidual))),
    tolerance: 1e-9 * totalNav0 + 1e-12,
  };
  const reconciled = Math.abs(reconciliation.residualWho) <= reconciliation.tolerance
    && Math.abs(reconciliation.residualWhy) <= reconciliation.tolerance
    && reconciliation.maxIdentityResidual <= reconciliation.tolerance;

  const totalForcedSales = rounds.reduce((s, rd) => s + Object.values(rd.sold).reduce((a, b) => a + b, 0), 0);
  const value = {
    rounds, funds: fundsOut,
    system: {
      totalLoss, byWho: sysWho, byWhy: sysWhy, reconciliation, reconciled,
      converged, roundsRun: r, totalForcedSales,
      failedFunds: fundsOut.filter((f) => f.failed).map((f) => f.id), lossFractionOfNav: totalLoss / totalNav0,
    },
    finalPrices: Object.fromEntries(A.map((a, k) => [a.id, price[k]])),
    lowerBound: lowerBoundReasons.size > 0, lowerBoundReasons: [...lowerBoundReasons],
  };
  let status = STATUS.UNCALIBRATED; // cascade structure is uncalibrated; numbers are scenario outputs
  const notes = ['Scenario outputs under stated assumptions; model parameters are UNCALIBRATED. Not a forecast.'];
  if (!converged) { status = STATUS.MODEL_UNCERTAIN; notes.push(`did not converge within ${opt.maxRounds} rounds`); }
  else if (!reconciled) { status = STATUS.COMPUTATION_FAILED; notes.push('loss decomposition failed to reconcile'); }
  else if (unobservedChannels.size > 0) { status = STATUS.INSUFFICIENT_OBSERVABILITY; notes.push('some channels are UNOBSERVED and excluded: totals are lower bounds for those channels'); }
  return makeResult({
    engine: ENGINE, modelId: 'M10.cascade', status, value,
    unobserved: [...unobservedChannels], calibration: CALIBRATION.UNCALIBRATED,
    parameters: { policy: opt.policy, maxRounds: opt.maxRounds, channels: opt.channels, impact: system.impact, shocks, redemptions: scenario.redemptions || {} },
    inputHashes: [hashOf(system)], notes,
  });
}

/** Convenience: total loss fraction (for reverse stress / counterfactuals). */
export function systemLossFraction(res) {
  return res.value ? res.value.system.lossFractionOfNav : NaN;
}
