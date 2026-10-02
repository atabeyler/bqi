import { makeResult, failed, STATUS, CALIBRATION, coverageOf } from '../../core/result.js';
import { hashOf } from '../../core/canonical.js';
import { parameterBand } from '../../core/sensitivity.js';
import { isNum, isNonNeg, isFrac, unobs } from '../../core/numeric.js';
import { priceImpact } from '../impact.js';
import { hhi } from '../concentration.js';
import { validateSystemState, indexSystem, sumArr } from './state.js';
import { propagate } from './crossSector.js';

const ENGINE = 'digitalAssets';
export const MODEL_ID = 'M69.digital_assets';
export const MAX_ROUNDS = 100;

// ---------------------------------------------------------------- constant-product AMM primitives (closed forms)
/** Sells dx of token A into pool (x=A, y=B, invariant xy=k, fee f on input). Returns {out, x1, y1, priceBefore, priceAfter}. */
export function cpmmSell(pool, dx) {
  const { x, y } = pool; const f = pool.fee ?? 0; const din = dx * (1 - f);
  const out = (y * din) / (x + din);
  return { out, x1: x + dx, y1: y - out, priceBefore: y / x, priceAfter: (y - out) / (x + dx) };
}
/** Marginal-price-equalising split of a sale of Q across pools (fees ignored): final marginal price p' with sum_k max(0, sqrt(k_k/p') - x_k) = Q. */
export function splitSell(pools, Q) {
  const ks = pools.map((p) => p.x * p.y); const pMax = Math.max(...pools.map((p) => p.y / p.x));
  const total = (pp) => sumArr(pools.map((p, i) => Math.max(0, Math.sqrt(ks[i] / pp) - p.x)));
  let lo = 1e-300; let hi = pMax; // price falls from pMax (no sale) towards lo
  for (let it = 0; it < 300; it++) { const mid = Math.sqrt(lo * hi); if (total(mid) > Q) lo = mid; else hi = mid; }
  const pf = Math.sqrt(lo * hi);
  const dx = pools.map((p, i) => Math.max(0, Math.sqrt(ks[i] / pf) - p.x));
  const out = sumArr(pools.map((p, i) => (dx[i] > 0 ? p.y - ks[i] / (p.x + dx[i]) : 0)));
  return { dx, out, finalPrice: pf };
}

export function validateDigital(system, scenario) {
  const d = system.digital;
  if (!d || typeof d !== 'object') return 'system.digital required';
  const eIds = new Map(system.entities.map((e) => [e.id, e])); const aIds = new Set((system.assets ?? []).map((a) => a.id));
  const tokens = new Set(); const pools = new Map();
  for (const p of d.pools || []) {
    if (!p.id || pools.has(p.id)) return 'pool id missing/duplicate';
    if (!p.tokenA || !p.tokenB || p.tokenA === p.tokenB) return `pool ${p.id}: invalid token pair`;
    if (!unobs(p.reserveA) && !(isNum(p.reserveA) && p.reserveA > 0)) return `pool ${p.id}: reserveA must be null or > 0`;
    if (!unobs(p.reserveB) && !(isNum(p.reserveB) && p.reserveB > 0)) return `pool ${p.id}: reserveB must be null or > 0`;
    if (!isFrac(p.fee ?? 0) || (p.fee ?? 0) >= 1) return `pool ${p.id}: fee must be in [0,1)`;
    pools.set(p.id, p); tokens.add(p.tokenA); tokens.add(p.tokenB);
  }
  for (const s of d.stablecoins || []) {
    const e = eIds.get(s.entity); if (!e || e.sector !== 'STABLECOIN') return `stablecoin ${s.entity}: must be an entity with sector STABLECOIN`;
    if (unobs(e.externalLiabilities) && !system.exposures?.some((x) => x.debtor === s.entity)) return `stablecoin ${s.entity}: liabilities (externalLiabilities or exposures) required`;
    for (const [a, h] of Object.entries(s.liquidationHaircut || {})) if (!aIds.has(a) || !isFrac(h) || h >= 1) return `stablecoin ${s.entity}: invalid haircut ${a}`;
  }
  for (const l of d.lending || []) {
    if (!eIds.has(l.entity) || eIds.get(l.entity).sector !== 'DEFI') return `lending ${l.id}: entity must have sector DEFI`;
    if (!pools.has(l.oraclePool)) return `lending ${l.id}: oraclePool must reference a pool`;
    if (!(isNum(l.liquidationThreshold) && l.liquidationThreshold > 0 && l.liquidationThreshold <= 1)) return `lending ${l.id}: liquidationThreshold in (0,1]`;
    if (!isNonNeg(l.liquidationPenalty) || !(isNum(l.closeFactor) && l.closeFactor > 0 && l.closeFactor <= 1)) return `lending ${l.id}: invalid penalty/closeFactor`;
    const p = pools.get(l.oraclePool); if (p.tokenA !== l.collateralToken) return `lending ${l.id}: oracle pool tokenA must be the collateral token`;
    for (const pos of l.positions || []) if (!isNonNeg(pos.collateral) || !isNonNeg(pos.debt)) return `lending ${l.id}: invalid position`;
  }
  for (const b of d.bridges || []) { if (!pools.size || !isNonNeg(b.locked) || !(isNum(b.wrappedSupply) && b.wrappedSupply > 0) || !b.wrappedToken) return `bridge ${b.id}: invalid`; if (b.wrappedPool && !pools.has(b.wrappedPool)) return `bridge ${b.id}: unknown wrappedPool`; }
  for (const v of d.venues || []) { if (!v.token || !(v.pools?.length) || v.pools.some((id) => !pools.has(id))) return 'venues: invalid'; }
  const sc = scenario.digital ?? {};
  for (const [id, f] of Object.entries(sc.stablecoinRedemptions || {})) if (!(d.stablecoins || []).some((s) => s.entity === id) || !isFrac(f)) return `stablecoinRedemptions.${id} invalid`;
  for (const [id, s] of Object.entries(sc.poolShocks || {})) if (!pools.has(id) || !isFrac(s) || s >= 1) return `poolShocks.${id} invalid`;
  for (const f of sc.bridgeFailures || []) if (!(d.bridges || []).some((b) => b.id === f.id) || !isFrac(f.lossFractionOfLocked)) return 'bridgeFailures invalid';
  for (const [id, v] of Object.entries(sc.oracleDeviation || {})) if (!(d.lending || []).some((l) => l.id === id) || !(isNum(v) && v > -1 && v < 1)) return `oracleDeviation.${id} invalid`;
  for (const [k, v] of Object.entries(sc.fragmentationSell || {})) if (!(d.venues || []).some((x) => x.token === k) || !(isNum(v) && v > 0)) return `fragmentationSell.${k} invalid`;
  return null;
}

/** Stablecoin run with sequential service: liquid reserves pay at par in order cash -> bank deposits -> marketable assets; remaining holders share what is left. */
export function stablecoinRun(system, ix, s, frac, assetPrice, impactState) {
  const i = ix.eIdx.get(s.entity); const e = ix.E[i]; const unobserved = [];
  let L = e.externalLiabilities ?? 0; ix.edges.forEach((x) => { if (x.d === i && x.amount !== null) L += x.amount; });
  const cashV = e.cash; const deposits = []; ix.edges.forEach((x, k) => { if (x.c === i && x.amount !== null) deposits.push({ k, bank: ix.E[x.d].id, amount: x.amount }); });
  const assets = []; for (let k = 0; k < ix.nA; k++) if (ix.q[i][k] > 0) { const h = s.liquidationHaircut?.[ix.A[k].id]; if (h === undefined) unobserved.push(`liquidation_haircut:${s.entity}:${ix.A[k].id}`); assets.push({ k, id: ix.A[k].id, value: ix.q[i][k] * assetPrice[k], haircut: h ?? 0, haircutObserved: h !== undefined }); }
  const R = frac * L; let rem = R; const paid = { cash: 0, deposits: 0, assets: 0 }; const bankOutflow = {}; const sales = {}; const salesNet = {}; let haircutLoss = 0;
  const fromCash = Math.min(cashV, rem); paid.cash = fromCash; rem -= fromCash;
  const dep = []; for (const d of deposits) { if (rem <= 1e-12) break; const t = Math.min(d.amount, rem); paid.deposits += t; rem -= t; bankOutflow[d.bank] = (bankOutflow[d.bank] || 0) + t; dep.push({ ...d, withdrawn: t }); }
  for (const a of assets) {
    if (rem <= 1e-12) break;
    const net = a.value * (1 - a.haircut); const t = Math.min(net, rem); const grossSold = a.haircut < 1 ? t / (1 - a.haircut) : 0;
    paid.assets += t; rem -= t; sales[a.id] = (sales[a.id] || 0) + grossSold; salesNet[a.id] = (salesNet[a.id] || 0) + t; haircutLoss += grossSold - t;
    const imp = priceImpact(system.impact ?? { model: 'amihud-linear' }, ix.A[a.k], grossSold);
    if (imp === null) unobserved.push(`impact_inputs:${a.id}`); else impactState[a.k] = imp;
  }
  const paidTotal = paid.cash + paid.deposits + paid.assets; const shortfall = rem;
  const remainingLiab = L - paidTotal;
  const remainingRecoverable = Math.max(0, (cashV - paid.cash) + sumArr(deposits.map((d) => d.amount)) - paid.deposits + sumArr(assets.map((a) => a.value * (1 - a.haircut))) - paid.assets);
  const pegAfter = remainingLiab > 1e-12 ? Math.min(1, remainingRecoverable / remainingLiab) : 1;
  return { issuer: s.entity, liabilities: L, redemptionRequested: R, paidAtPar: paidTotal, paidFrom: paid, unpaid: shortfall, pegPriceRemainingHolders: pegAfter, assetSales: sales, assetSalesNet: salesNet, haircutLoss, bankDepositWithdrawals: bankOutflow, depositEdges: dep, runnable: R > cashV + sumArr(deposits.map((d) => d.amount)) + sumArr(assets.map((a) => a.value * (1 - a.haircut))), unobserved };
}

/** Lending liquidation cascade against AMM-priced collateral. Mutates the supplied pool copies only. */
export function lendingCascade(l, pool, oracleDev, pegPrice = 1) {
  const pos = l.positions.map((p) => ({ ...p, owner: p.owner, collateral: p.collateral, debt: p.debt }));
  const rounds = []; let bad = 0; let liquidatedDebt = 0; let seizedQty = 0;
  for (let r = 0; r < MAX_ROUNDS; r++) {
    const Po = (pool.y / pool.x) * (1 + oracleDev); const liq = [];
    for (const p of pos) {
      if (p.debt <= 0 || p.collateral <= 0) continue;
      const hf = (p.collateral * Po * l.liquidationThreshold) / (p.debt * pegPrice);
      if (hf < 1) liq.push(p);
    }
    const rec = { round: r, oraclePrice: Po, liquidatable: liq.length, repaid: 0, seized: 0, priceAfter: null };
    if (!liq.length) { rounds.push(rec); return { rounds, bad, liquidatedDebt, seizedQty, finalPoolPrice: pool.y / pool.x, converged: true, positions: pos }; }
    let sellQty = 0;
    for (const p of liq) {
      const repay = Math.min(p.debt, l.closeFactor * p.debt); const want = (repay * pegPrice * (1 + l.liquidationPenalty)) / Po; const seize = Math.min(p.collateral, want);
      const repaid = seize < want ? (seize * Po) / (pegPrice * (1 + l.liquidationPenalty)) : repay;
      p.collateral -= seize; p.debt -= repaid; sellQty += seize; rec.repaid += repaid; rec.seized += seize; liquidatedDebt += repaid; seizedQty += seize;
      if (p.collateral <= 1e-15 && p.debt > 1e-12) { bad += p.debt * pegPrice; p.debt = 0; }
    }
    const res = cpmmSell(pool, sellQty); pool.x = res.x1; pool.y = res.y1; rec.priceAfter = pool.y / pool.x; rounds.push(rec);
  }
  return { rounds, bad, liquidatedDebt, seizedQty, finalPoolPrice: pool.y / pool.x, converged: false, positions: pos };
}

export function digitalChain(system, scenario, p, ix = indexSystem(system)) {
  const d = system.digital; const sc = scenario.digital ?? {}; const unobserved = []; const lb = new Set();
  const pools = new Map(); for (const q of d.pools || []) {
    if (unobs(q.reserveA) || unobs(q.reserveB)) { unobserved.push(`pool_reserves:${q.id}`); lb.add('pools with unobserved reserves are excluded (liquidity treated as unknown, not infinite)'); continue; }
    pools.set(q.id, { id: q.id, x: q.reserveA, y: q.reserveB, fee: q.fee ?? 0, tokenA: q.tokenA, tokenB: q.tokenB, x0: q.reserveA, y0: q.reserveB });
  }
  // ---- bridges -> wrapped-token price shock via its pool
  const bridges = [];
  for (const f of sc.bridgeFailures || []) {
    const b = d.bridges.find((x) => x.id === f.id); const backing = Math.min(1, (b.locked * (1 - f.lossFractionOfLocked * p.bridgeLossScale)) / b.wrappedSupply);
    bridges.push({ bridge: b.id, wrappedToken: b.wrappedToken, backingRatio: backing, wrappedPriceFactor: backing });
    const pl = b.wrappedPool ? pools.get(b.wrappedPool) : null;
    if (pl) { const s = 1 - backing; pl.x = pl.x / Math.sqrt(1 - s || 1e-12); pl.y = pl.y * Math.sqrt(1 - s || 1e-12); }
    else { unobserved.push(`bridge_pool:${b.id}`); lb.add('bridge without a priced pool: wrapped-token revaluation not propagated to lending markets'); }
  }
  // ---- explicit pool price shocks (exogenous external repricing at constant k)
  for (const [id, s] of Object.entries(sc.poolShocks || {})) { const pl = pools.get(id); if (!pl) continue; pl.x /= Math.sqrt(1 - s); pl.y *= Math.sqrt(1 - s); }
  // ---- stablecoin runs (marketable-reserve sales -> asset price impact, bank deposit outflows)
  const assetPrice = p.assetMarks ? p.assetMarks.slice() : ix.price.slice(); const impactState = new Array(ix.nA).fill(0); const runs = [];
  for (const s of d.stablecoins || []) { const f = sc.stablecoinRedemptions?.[s.entity]; if (!f) continue; const r = stablecoinRun(system, ix, s, Math.min(1, f * p.runScale), assetPrice, impactState); r.unobserved.forEach((u) => { unobserved.push(u); lb.add('unobserved liquidation haircut/impact parameters: sales proceeds/impact are unquantified (not zero); lower bound'); }); runs.push(r); }
  const pegOf = (tok) => { const r = runs.find((x) => d.stablecoins.some((s) => s.entity === x.issuer && s.token === tok)); return r ? r.pegPriceRemainingHolders : 1; };
  // ---- lending cascades
  const lend = [];
  for (const l of d.lending || []) {
    const pl = pools.get(l.oraclePool); if (!pl) { unobserved.push(`lending_oracle_pool:${l.id}`); continue; }
    const dev = sc.oracleDeviation?.[l.id] ?? 0; const before = pl.y / pl.x;
    const res = lendingCascade(l, pl, dev, pegOf(l.debtToken));
    lend.push({ id: l.id, entity: l.entity, oracleDeviation: dev, poolPriceBefore: before, poolPriceAfter: res.finalPoolPrice, priceDecline: 1 - res.finalPoolPrice / before, rounds: res.rounds, badDebt: res.bad, liquidatedDebt: res.liquidatedDebt, seizedQty: res.seizedQty, converged: res.converged, positionsAtRisk: res.rounds[0].liquidatable, positions: res.positions });
  }
  // ---- liquidity fragmentation (sell sizing from scenario)
  const frag = [];
  for (const v of d.venues || []) {
    const q = sc.fragmentationSell?.[v.token]; if (!q) continue;
    const all = v.pools.map((id) => pools.get(id)).filter(Boolean); const reach = all.filter((x) => (d.pools.find((pp) => pp.id === x.id).reachable ?? true));
    if (!reach.length) { unobserved.push(`venue_reachability:${v.token}`); continue; }
    const biggest = reach.slice().sort((a, b) => b.x * b.y - a.x * a.y || a.id.localeCompare(b.id))[0];
    const single = cpmmSell({ x: biggest.x0, y: biggest.y0, fee: 0 }, q).out; const split = splitSell(reach.map((x) => ({ x: x.x0, y: x.y0 })), q).out;
    const consol = cpmmSell({ x: sumArr(all.map((x) => x.x0)), y: sumArr(all.map((x) => x.y0)), fee: 0 }, q).out;
    frag.push({ token: v.token, size: q, outputSingleLargestVenue: single, outputOptimalSplitReachable: split, outputIfFullyConsolidated: consol, executionShortfallVsConsolidated: consol - split, reachableDepthShare: sumArr(reach.map((x) => x.y0)) / sumArr(all.map((x) => x.y0)) });
  }
  // ---- oracle / bridge dependency structure
  const byOracle = {}; for (const l of d.lending || []) byOracle[l.oraclePool] = (byOracle[l.oraclePool] || 0) + sumArr((l.positions || []).map((x) => x.debt));
  const totalDebt = sumArr(Object.values(byOracle));
  const oracleConc = totalDebt > 0 ? hhi(Object.entries(byOracle).map(([id, v]) => ({ id, w: v / totalDebt })), { entity: 'oracles' }).value : null;
  const oracleSensitivity = (d.lending || []).flatMap((l) => { const pl = pools.get(l.oraclePool); if (!pl) return []; return (l.positions || []).filter((x) => x.debt > 0 && x.collateral > 0).map((x) => { const hf0 = (x.collateral * (pl.y0 / pl.x0) * l.liquidationThreshold) / x.debt; const buffer = 1 - 1 / hf0; return { lending: l.id, owner: x.owner, healthFactor0: hf0, priceDeclineToLiquidation: buffer > 0 ? buffer : 0, saleIntoOraclePoolToTrigger: buffer > 0 ? pl.x0 * (1 / Math.sqrt(1 - buffer) - 1) / (1 - pl.fee) : 0 }; }); });
  // ---- hand-off deltas for the shared network
  const dA = new Array(ix.n).fill(0); const dL = new Array(ix.n).fill(0); const edgeAmounts = ix.edges.map((x) => x.amount); const forcedSales = {}; const bankOutflow = {};
  for (const r of runs) {
    const i = ix.eIdx.get(r.issuer); dA[i] -= r.paidFrom.cash + sumArr(Object.values(r.assetSales)); dL[i] -= r.paidAtPar; // cash paid out + gross assets sold leave the issuer; deposits leave via the edge reduction
    for (const w of r.depositEdges) { edgeAmounts[w.k] = w.amount - w.withdrawn; dA[ix.eIdx.get(w.bank)] -= w.withdrawn; bankOutflow[w.bank] = (bankOutflow[w.bank] || 0) + w.withdrawn; }
    for (const [a, v] of Object.entries(r.assetSales)) forcedSales[a] = (forcedSales[a] || 0) + v;
  }
  for (const l of lend) dA[ix.eIdx.get(l.entity)] -= l.badDebt;
  // twin variant: issuer asset sales are executed on the twin's live holdings (shares removed), so their gross value must not also be booked as a delta
  const dATwin = dA.slice(); const issuerSalesValue = {}; const issuerSalesNet = {};
  for (const r of runs) { const i = ix.eIdx.get(r.issuer); issuerSalesValue[r.issuer] = r.assetSales; issuerSalesNet[r.issuer] = r.assetSalesNet; dATwin[i] += sumArr(Object.values(r.assetSales)); } // twin: issuer cash payments only; sold assets are removed from live holdings
  return { runs, lending: lend, bridges, fragmentation: frag, structure: { oracleConcentration: oracleConc, oracleSensitivity }, handoff: { extAssetsDelta: dA, extAssetsDeltaTwin: dATwin, issuerAssetSalesValue: issuerSalesValue, issuerAssetSalesNetValue: issuerSalesNet, extLiabDelta: dL, edgeAmounts, forcedSales, assetImpact: Object.fromEntries(ix.A.map((a, k) => [a.id, impactState[k]]).filter((x) => x[1] > 0)), bankLiquidityOutflow: bankOutflow, stablecoinPeg: Object.fromEntries(runs.map((r) => [r.issuer, r.pegPriceRemainingHolders])) }, unobserved: [...new Set(unobserved)], lowerBoundReasons: [...lb] };
}

/** M69 digital assets: stablecoin run/redemption, tokenised-asset liquidity, DeFi leverage/liquidation cascades, oracle/bridge dependency, liquidity fragmentation, on-chain contagion via the shared network. */
export function runDigitalAssets(system, scenario = {}, options = {}) {
  const err = validateSystemState(system) || validateDigital(system, scenario);
  if (err) return failed(ENGINE, MODEL_ID, err);
  const ix = indexSystem(system); const p = { runScale: 1, bridgeLossScale: 1 };
  const run = (pp) => { const ch = digitalChain(system, scenario, pp, ix); const prop = propagate(system, { priceShocks: Object.fromEntries(Object.entries(ch.handoff.assetImpact).map(([a, v]) => [a, Math.min(1, v)])) }, { alpha: 1, beta: 1, maxIter: 50000 }, { ix, extAssetsDelta: ch.handoff.extAssetsDelta, extLiabDelta: ch.handoff.extLiabDelta, edgeAmounts: ch.handoff.edgeAmounts }); return { ch, prop }; };
  const { ch, prop } = run(p);
  const unobserved = [...new Set([...ch.unobserved, ...prop.unobserved])];
  let status = STATUS.UNCALIBRATED; const notes = ['On-chain mechanics (constant-product AMM, liquidation rules) are exact accounting identities; run intensity, oracle deviation and bridge-loss inputs are SCENARIO assumptions. UNCALIBRATED.'];
  const convergedAll = ch.lending.every((x) => x.converged);
  if (!prop.system.converged || !convergedAll) { status = STATUS.MODEL_UNCERTAIN; notes.push('cascade or clearing did not converge'); } else if (!prop.system.reconciled) status = STATUS.COMPUTATION_FAILED;
  else if (unobserved.length) { status = STATUS.INSUFFICIENT_OBSERVABILITY; notes.push('unobserved inputs excluded: lower bound'); }
  const u = options.uncertainty ?? {};
  const uncertainty = parameterBand({ evaluate: (pp) => run({ ...p, ...pp }).prop.system.systemLoss + sumArr(run({ ...p, ...pp }).ch.lending.map((x) => x.badDebt)), params: p, keys: ['runScale', 'bridgeLossScale'], ranges: u.ranges ?? { runScale: [0.5, 1], bridgeLossScale: [0.5, 1] }, n: u.n ?? 16, seed: options.seed ?? 1, label: ENGINE });
  const contagion = prop;
  const lendingOut = ch.lending.map((x) => ({ ...x, positions: undefined }));
  return makeResult({
    engine: ENGINE, modelId: MODEL_ID, status,
    value: { stablecoinRuns: ch.runs, lending: lendingOut, bridges: ch.bridges, fragmentation: ch.fragmentation, structure: ch.structure, contagion, lowerBound: unobserved.length > 0, handoff: ch.handoff },
    uncertainty, coverage: coverageOf(Math.max(0, (system.digital.pools?.length ?? 0) - unobserved.filter((x) => x.startsWith('pool_reserves')).length), Math.max(1, system.digital.pools?.length ?? 1)), unobserved, calibration: CALIBRATION.UNCALIBRATED,
    parameters: { ...p, scenario: scenario.digital, ammInvariant: 'x*y=k', stablecoinService: 'sequential service: cash -> deposits -> marketable assets, remaining holders pro-rata' },
    inputHashes: [hashOf(system.digital)], notes,
  });
}
