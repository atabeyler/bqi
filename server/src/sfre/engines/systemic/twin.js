import { makeResult, failed, STATUS, CALIBRATION, coverageOf } from '../../core/result.js';
import { hashOf } from '../../core/canonical.js';
import { parameterBand } from '../../core/sensitivity.js';
import { isFrac, isNonNeg, unobs } from '../../core/numeric.js';
import { priceImpact } from '../impact.js';
import { runCascade, validateSystem as validateFundSystem } from '../cascade.js';
import { validateSystemState, indexSystem, sumArr } from './state.js';
import { propagate, validateScenario } from './crossSector.js';
import { validateFx, fxChain, fxParams } from './fxContagion.js';
import { validateNexus, nexusLoop, nexusParams } from './nexus.js';
import { validateCollateral, collateralStress, collateralParams } from './collateral.js';
import { validateCcp, ccpWaterfall } from './ccp.js';
import { validatePrivateCredit, privateCreditEffects } from './privateCredit.js';
import { validateCrowding, crowdingSetup, crowdingFeedback } from './crowding.js';
import { validateOp, opChain } from './opContagion.js';
import { validateClimate, climateTransmission, climateParams } from './climate.js';
import { validateDigital, digitalChain } from './digitalAssets.js';

const ENGINE = 'systemTwin';
export const MODEL_ID = 'M71.system_twin';
export const STAGES = Object.freeze(['STATE(t0)', 'SHOCK', 'BALANCE_SHEET_EFFECT', 'FUNDING_LIQUIDITY', 'MARGIN_COLLATERAL', 'FORCED_ACTION', 'MARKET_IMPACT', 'COUNTERPARTY_NETWORK_CONTAGION', 'SECOND_ROUND', 'STATE(t+n)']);
/** module -> [system section, scenario key]. A module runs only when BOTH are present (explicit opt-in per scenario). */
export const MODULES = Object.freeze({ climate: ['climate', 'climate'], fx: ['fx', 'fx'], nexus: ['sovereign', 'sovereign'], privateCredit: ['privateCredit', 'privateCredit'], digital: ['digital', 'digital'], opDeps: ['opDeps', 'opDeps'], crowding: ['crowding', 'crowding'], collateral: ['collateral', 'collateral'], ccp: ['ccps', 'ccp'] });
export const MODULE_MODELS = Object.freeze({ climate: 'M68.climate_nature', fx: 'M61.fx_contagion', nexus: 'M62.sovereign_bank_corporate', privateCredit: 'M65.private_credit', digital: 'M69.digital_assets', opDeps: 'M67.operational_contagion', crowding: 'M66.ai_crowding', collateral: 'M63.margin_collateral', ccp: 'M64.ccp_default_waterfall', crossSector: 'M60.cross_sector', fundCascade: 'M10.cascade' });
/** Documented hand-offs between engines (one engine's output is another's input). */
export const DATAFLOW = Object.freeze([
  { from: 'M68.climate', to: 'M71 price vector / balance sheets', field: 'assetHaircuts, extAssetsDelta' },
  { from: 'M71 price vector + balance-sheet deltas', to: 'M62.nexus', field: 'pre-applied bank losses (capital shortfall sees climate/FX/private-credit losses)' },
  { from: 'M61.fx', to: 'M71 funding stage', field: 'entityFcyGap (FCY roll-over shortfalls)' },
  { from: 'M61.fx', to: 'M71 market impact', field: 'domesticAssetSales (foreign-investor outflow)' },
  { from: 'M65.private_credit', to: 'M71 funding stage', field: 'bank facility draws (liquidity outflow)' },
  { from: 'M69.digital', to: 'M71 funding stage + market impact', field: 'deposit withdrawals, reserve-asset sales' },
  { from: 'M67.operational', to: 'M71 funding stage', field: 'incrementalLiquidityGap' },
  { from: 'M71 funding stage', to: 'M71 forced action', field: 'liquidity gap after cash' },
  { from: 'M71 price vector (cumulative)', to: 'M63.collateral', field: 'variation margin, haircut/IM top-ups on live prices' },
  { from: 'M63.collateral', to: 'M71 market impact', field: 'collateral & repo fire sales' },
  { from: 'M63.collateral + M60 clearing', to: 'M64.ccp', field: 'defaulted members' },
  { from: 'M64.ccp', to: 'M71 balance sheets', field: 'survivor default-fund / assessment charges' },
  { from: 'M66.crowding', to: 'M71 market impact', field: 'correlated sell orders + stop-loss deleveraging driven by live prices' },
  { from: 'M71 market impact', to: 'M63 / M66 / M60 (next round)', field: 'updated prices' },
  { from: 'M60 clearing', to: 'M71 funding stage (next round)', field: 'equity ratios drive confidence run-off' },
  { from: 'M10.cascade (optional fundSystem)', to: 'M71 price vector', field: 'fund-caused price decline (multiplicative composition, ASSUMED)' },
]);

export const activeModules = (system, scenario) => Object.entries(MODULES).filter(([, [s, k]]) => system[s] && scenario[k] !== undefined && scenario[k] !== null).map(([m]) => m);

export function validateTwin(system, scenario, options = {}, fundSystem = null) {
  let e = validateSystemState(system, { requireImpact: true }) || validateScenario(system, scenario);
  if (e) return e;
  // a scenario key without its system section (or an unknown key) is an error, never silently ignored
  const known = new Set(['priceShocks', 'externalShocks', 'sectorShocks', 'redemptions', ...Object.values(MODULES).map(([, k]) => k)]);
  for (const k of Object.keys(scenario)) if (!known.has(k)) return `unknown scenario key "${k}"`;
  for (const [m, [sec, key]] of Object.entries(MODULES)) if (scenario[key] !== undefined && scenario[key] !== null && !system[sec]) return `scenario.${key} given but system.${sec} is missing (module ${m})`;
  for (const m of activeModules(system, scenario)) {
    const v = { climate: validateClimate, fx: validateFx, nexus: validateNexus, privateCredit: validatePrivateCredit, digital: validateDigital, opDeps: validateOp, crowding: validateCrowding, collateral: validateCollateral, ccp: validateCcp }[m];
    e = v(system, scenario); if (e) return `${m}: ${e}`;
  }
  for (const ent of system.entities) {
    const f = ent.funding; if (!f) continue;
    if (!unobs(f.runnable) && (!isNonNeg(f.runnable) || (isNonNeg(ent.externalLiabilities) && f.runnable > ent.externalLiabilities + 1e-9))) return `entity ${ent.id}: funding.runnable must be null or in [0, externalLiabilities]`;
    for (const k of ['runoff', 'stressRunoff']) if (!unobs(f[k]) && !isFrac(f[k])) return `entity ${ent.id}: funding.${k} must be null or in [0,1]`;
    if (!unobs(f.confidenceThreshold) && !(f.confidenceThreshold > 0 && f.confidenceThreshold < 1)) return `entity ${ent.id}: funding.confidenceThreshold must be null or in (0,1)`;
  }
  if (!Number.isInteger(options.maxRounds ?? 20) || (options.maxRounds ?? 20) < 1 || (options.maxRounds ?? 20) > 50) return 'options.maxRounds must be an integer in [1,50]';
  if (fundSystem?.funds?.length) {
    const fe = validateFundSystem(fundSystem); if (fe) return `fundSystem: ${fe}`;
    const assets = new Map(system.assets.map((a) => [a.id, a])); const ids = new Set(system.entities.map((x) => x.id));
    for (const a of fundSystem.assets) { const b = assets.get(a.id); if (!b || b.price !== a.price) return `fundSystem asset ${a.id} must exist in system.assets with the same price`; }
    for (const f of fundSystem.funds) if (ids.has(f.id)) return `fundSystem fund ${f.id} collides with a system entity id (model each fund once)`;
  }
  return null;
}

const zeros = (n) => new Array(n).fill(0);
const addInto = (a, b) => { for (let i = 0; i < a.length; i++) a[i] += b[i]; };

/**
 * Runs the full SHOCK -> BALANCE-SHEET EFFECT -> FUNDING/LIQUIDITY -> MARGIN/COLLATERAL -> FORCED ACTION -> MARKET IMPACT
 * -> COUNTERPARTY/NETWORK CONTAGION -> SECOND-ROUND -> STATE(t+n) pipeline. Pure; never mutates its inputs.
 *
 * Live working state W = {price[], cash[], q[][], enc[][], defaulted[]}. Cumulative, additive balance-sheet deltas are kept per
 * engine (dA, dL) so that every unit of value lost is attributable; the final ledger reconciles to the clearing engine's loss.
 */
export function simulateSystem(system, scenario, options = {}, fundSystem = null) {
  const ix = indexSystem(system); const { E, A, n, nA } = ix;
  const opt = { maxRounds: options.maxRounds ?? 20, alpha: options.alpha ?? 1, beta: options.beta ?? 1, runoffScale: options.runoffScale ?? 1, seed: options.seed ?? 1, tol: 1e-10 };
  const act = new Set(activeModules(system, scenario));
  const unobserved = new Set(); const lowerBound = new Set(); const dataflow = []; const notes = [];
  const flag = (u, why) => { (Array.isArray(u) ? u : [u]).forEach((x) => unobserved.add(x)); if (why) lowerBound.add(why); };
  const P0 = ix.price.slice();
  const W = { price: P0.slice(), cash: E.map((e) => e.cash), q: ix.q.map((r) => r.slice()), enc: E.map(() => zeros(nA)), defaulted: new Array(n).fill(false) };
  const cash0 = W.cash.slice();
  const nominal = ix.edges.map((x) => x.amount);
  const dA = {}; const dL = {}; // engine -> per-entity signed deltas (external assets / liabilities outside the network)
  const edgeFactor = ix.edges.map(() => 1);
  const Sexo = zeros(nA); // exogenous cumulative price decline
  const flowsR0 = zeros(nA); const needR0 = zeros(n); // round-0 external sell flows (value) and cash obligations
  const mod = (name) => { dA[name] ||= zeros(n); dL[name] ||= zeros(n); return name; };
  const shock = (k, s) => { Sexo[k] = 1 - (1 - Sexo[k]) * (1 - s); };
  const mulEdges = (amounts) => amounts.forEach((a, e) => { if (a !== null && nominal[e] !== null && nominal[e] > 0) edgeFactor[e] *= a / nominal[e]; });
  const edgeAmounts = () => ix.edges.map((x, e) => (x.amount === null ? null : x.amount * edgeFactor[e]));
  const priceMap = () => Object.fromEntries(A.map((a, k) => [a.id, Sexo[k]]).filter((x) => x[1] > 0));
  const sumDelta = (obj) => { const t = zeros(n); for (const v of Object.values(obj)) addInto(t, v); return t; };
  for (const [id, s] of Object.entries(scenario.priceShocks || {})) shock(ix.aIdx.get(id), s);

  // ================= SHOCK (round 0): exogenous engines in dependency order; each one sees what the previous ones produced
  const stage0 = [];
  if (act.has('climate')) {
    const t = climateTransmission(system, scenario, climateParams(system, options), ix);
    for (const [a, s] of Object.entries(t.priceShocks)) shock(ix.aIdx.get(a), s);
    addInto(dA[mod('climate')], t.extAssetsDelta); flag(t.unobserved, t.lowerBoundReasons.join('; ') || null);
    stage0.push({ module: MODULE_MODELS.climate, priceShocks: t.priceShocks, effects: t.effects.length });
    dataflow.push({ from: 'M68.climate', to: 'price vector', field: 'assetHaircuts', n: Object.keys(t.priceShocks).length }, { from: 'M68.climate', to: 'balance sheets', field: 'extAssetsDelta', total: -sumArr(t.extAssetsDelta) });
  }
  if (act.has('fx')) {
    const ch = fxChain(system, scenario, fxParams(system, options), ix);
    addInto(dA[mod('fx')], ch.handoff.extAssetsDelta); addInto(dL.fx, ch.handoff.extLiabDelta); mulEdges(ch.handoff.edgeAmounts);
    for (const [a, v] of Object.entries(ch.handoff.domesticAssetSales)) flowsR0[ix.aIdx.get(a)] += v;
    for (const [id, g] of Object.entries(ch.handoff.entityFcyGap)) needR0[ix.eIdx.get(id)] += g;
    flag(ch.unobserved, ch.lowerBoundReasons.join('; ') || null);
    stage0.push({ module: MODULE_MODELS.fx, depreciation: ch.handoff.depreciation, fcyDemand: ch.stages.fxLiquidity.totalDemand });
    dataflow.push({ from: 'M61.fx', to: 'funding stage', field: 'entityFcyGap', total: sumArr(Object.values(ch.handoff.entityFcyGap)) }, { from: 'M61.fx', to: 'market impact', field: 'domesticAssetSales', total: sumArr(Object.values(ch.handoff.domesticAssetSales)) });
  }
  if (act.has('nexus')) {
    const pre = { priceShocks: priceMap(), extAssetsDelta: sumDelta(dA), extLiabDelta: sumDelta(dL), edgeAmounts: edgeAmounts() };
    const out = nexusLoop(system, scenario, nexusParams(system, options), options, ix, pre);
    if (out.error) throw Object.assign(new Error(`nexus: ${out.error}`), { code: 'INVALID_REQUEST' });
    shock(ix.aIdx.get(system.sovereign.bondAsset), 1 - out.last.f);
    addInto(dA[mod('nexus')], out.last.delta); flag(out.unobserved, out.lowerBoundReasons.join('; ') || null);
    stage0.push({ module: MODULE_MODELS.nexus, spreadBpsFinal: out.spreadBpsFinal, amplification: out.amplification, converged: out.converged });
    dataflow.push({ from: 'M68/M61 losses', to: 'M62.nexus', field: 'pre-applied bank losses', total: -sumArr(pre.extAssetsDelta) }, { from: 'M62.nexus', to: 'price vector', field: 'bond price shock', value: 1 - out.last.f });
    if (!out.converged) notes.push('sovereign-bank loop did not converge');
  }
  if (act.has('privateCredit')) {
    const eff = privateCreditEffects(system, scenario, { liquidationDiscount: scenario.privateCredit.liquidationDiscount ?? 0.15, seed: opt.seed }, ix);
    const d = eff.dA.slice();
    eff.amounts.forEach((a, e) => { if (a === null || nominal[e] === null) return; const delta = a - nominal[e]; const c = ix.edges[e].c; if (delta > 0) { needR0[c] += delta; d[c] += delta; } else if (delta < 0) { W.cash[c] += -delta; d[c] -= -delta; } }); // facility draws/repayments are liquidity flows (asset swaps), not equity
    addInto(dA[mod('privateCredit')], d); mulEdges(eff.amounts);
    eff.rows.forEach((r) => flag(r.unobserved, r.lb.join('; ') || null));
    stage0.push({ module: MODULE_MODELS.privateCredit, creditLoss: sumArr(eff.rows.map((r) => r.creditLoss)), gated: sumArr(eff.rows.map((r) => r.redemption.gated)) });
    dataflow.push({ from: 'M65.private_credit', to: 'funding stage', field: 'bank facility draws', total: sumArr(Object.values(eff.bankOutflow)) });
  }
  for (let k = 0; k < nA; k++) W.price[k] = P0[k] * (1 - Sexo[k]);
  const proceeds = E.map(() => zeros(nA)); // cash received from sales by entity x asset, at the mark of sale (net of explicit haircuts)
  if (act.has('digital')) {
    const ch = digitalChain(system, scenario, { runScale: 1, bridgeLossScale: 1, assetMarks: W.price }, ix);
    const d = ch.handoff.extAssetsDeltaTwin.slice();
    ch.handoff.edgeAmounts.forEach((a, e) => { if (a === null || nominal[e] === null) return; const delta = a - nominal[e]; if (delta < 0) { const dbt = ix.edges[e].d; needR0[dbt] += -delta; d[dbt] += -delta; } }); // deposit withdrawals: the debtor bank pays out cash
    addInto(dA[mod('digital')], d); addInto(dL.digital, ch.handoff.extLiabDelta); mulEdges(ch.handoff.edgeAmounts);
    for (const [iss, sales] of Object.entries(ch.handoff.issuerAssetSalesValue)) {
      const i = ix.eIdx.get(iss);
      for (const [a, v] of Object.entries(sales)) { const k = ix.aIdx.get(a); const sh = Math.min(W.q[i][k], v / W.price[k]); W.q[i][k] -= sh; flowsR0[k] += sh * W.price[k]; proceeds[i][k] += (v > 0 ? (ch.handoff.issuerAssetSalesNetValue[iss][a] / v) : 1) * sh * W.price[k]; }
    }
    flag(ch.unobserved, ch.lowerBoundReasons.join('; ') || null);
    stage0.push({ module: MODULE_MODELS.digital, bridges: ch.bridges.length, runs: ch.runs.length, lendingBadDebt: sumArr(ch.lending.map((x) => x.badDebt)) });
    dataflow.push({ from: 'M69.digital', to: 'market impact', field: 'issuer reserve-asset sales', total: sumArr(Object.values(ch.handoff.forcedSales)) }, { from: 'M69.digital', to: 'funding stage', field: 'bank deposit withdrawals', total: sumArr(Object.values(ch.handoff.bankLiquidityOutflow)) });
  }
  if (act.has('opDeps')) {
    const ch = opChain(system, scenario, { durationScale: 1, rerouteScale: 1 });
    for (const x of ch.entities) if (x.incrementalLiquidityGap > 0) needR0[ix.eIdx.get(x.entity)] += x.incrementalLiquidityGap;
    flag(ch.prop.unobserved, null);
    stage0.push({ module: MODULE_MODELS.opDeps, failedPayments: ch.failedTotal, scheduled: ch.scheduledTotal, marginDeliveryFailures: ch.marginFailures.length });
    dataflow.push({ from: 'M67.operational', to: 'funding stage', field: 'incrementalLiquidityGap', total: sumArr(ch.entities.map((x) => Math.max(0, x.incrementalLiquidityGap))) });
    if (ch.marginFailures.length) notes.push('operational margin-delivery failures are REPORTED but not propagated as defaults');
  }
  let crowd = null; let crowdLoss = zeros(n); let pendingCrowd = zeros(nA);
  if (act.has('crowding')) {
    crowd = crowdingSetup(system, scenario, { responseScale: scenario.crowding.responseScale, deleverageFraction: options.deleverageFraction ?? 0.5 }, ix);
    for (let k = 0; k < nA; k++) { const net = sumArr(crowd.order0.map((r) => r[k])); if (net < 0) flowsR0[k] += -net; } // buy-side flows are ignored (conservative)
    stage0.push({ module: MODULE_MODELS.crowding, effectiveIndependentStrategies: crowd.measures.effectiveIndependentStrategies, agents: crowd.agents.length });
    dataflow.push({ from: 'M66.crowding', to: 'market impact', field: 'correlated sell orders', total: sumArr(flowsR0) });
  }
  const scenShocks = { externalShocks: scenario.externalShocks, sectorShocks: scenario.sectorShocks };
  const imClaims = zeros(n); const repoLoss = zeros(n); let ccpCharges = zeros(n); let ccpOut = null;
  const unmetCarry = zeros(n); const fundingAcc = zeros(n); const outflowPaid = zeros(n);
  const clr = () => {
    const A_ = sumDelta(dA); for (let i = 0; i < n; i++) A_[i] += imClaims[i] - repoLoss[i] - ccpCharges[i] - crowdLoss[i];
    return propagate(system, scenShocks, { alpha: opt.alpha, beta: opt.beta, maxIter: 50000 }, { ix, work: W, extAssetsDelta: A_, extLiabDelta: sumDelta(dL), edgeAmounts: edgeAmounts() });
  };
  const sectorEquity = (prop) => { const o = {}; for (const x of prop.entities) if (!x.indeterminate) o[x.sector] = (o[x.sector] || 0) + x.equityFinal; return o; };
  // optional fund cascade (existing M10): fund-caused decline is tracked separately and composed multiplicatively
  const dFund = zeros(nA); let fundCascade = null;
  const runFunds = () => {
    if (!fundSystem?.funds?.length) return;
    const shocks = {}; fundSystem.assets.forEach((a) => { const k = ix.aIdx.get(a.id); shocks[a.id] = Math.min(1, Math.max(0, 1 - (W.price[k] / (1 - dFund[k])) / P0[k])); });
    const res = runCascade(fundSystem, { priceShocks: shocks, redemptions: scenario.redemptions }, options.cascade || {});
    if (!res.value) throw Object.assign(new Error(`fund cascade failed: ${res.error}`), { code: 'INVALID_REQUEST' });
    fundCascade = res;
    for (const a of fundSystem.assets) { const k = ix.aIdx.get(a.id); const base = P0[k] * (1 - shocks[a.id]); const d = base > 0 ? Math.max(0, 1 - res.value.finalPrices[a.id] / base) : 0; W.price[k] = base * (1 - d); dFund[k] = d; }
    if (res.unobserved.length) flag(res.unobserved, 'fund cascade has unobserved channels');
  };
  // persistent copy for margin-loan bookkeeping inside the collateral engine
  const sysC = act.has('collateral') ? JSON.parse(JSON.stringify(system)) : null; const ixC = sysC ? indexSystem(sysC) : null;

  // ================= STATE(t0), BALANCE_SHEET_EFFECT
  const base = propagate(system, {}, { alpha: opt.alpha, beta: opt.beta, maxIter: 50000 }, { ix });
  flag(base.unobserved, base.lowerBoundReasons.join('; ') || null);
  const trajectory = [{ t: 0, label: 'STATE(t0)', equityBySector: sectorEquity(base), defaults: base.system.defaults, prices: Object.fromEntries(A.map((a, k) => [a.id, P0[k]])) }];
  let prop = clr();
  const bsEffect = { directLoss: prop.system.directLoss, equityBySector: sectorEquity(prop), defaultsAfterShock: prop.system.defaults };

  // ================= rounds (second-round effects are simply the next iteration on the updated state)
  const roundsOut = []; let converged = false; let prevDefaults = new Set();
  for (let round = 0; round < opt.maxRounds; round++) {
    const rec = {}; const Q = zeros(nA); const sellers = { entities: 0, collateral: 0, external: 0, crowding: 0 };
    if (round === 0) for (let k = 0; k < nA; k++) { Q[k] += flowsR0[k]; sellers.external += flowsR0[k]; }
    for (let k = 0; k < nA; k++) { Q[k] += pendingCrowd[k]; sellers.crowding += pendingCrowd[k]; } pendingCrowd = zeros(nA);
    runFunds();
    // ---------- FUNDING / LIQUIDITY
    const need = zeros(n); const eqRatio = (i) => { const x = prop.entities[i]; if (x.indeterminate) return null; const a = x.equityFinal + x.nominalLiabilities; return a > 0 ? x.equityFinal / a : 0; };
    if (round === 0) for (let i = 0; i < n; i++) need[i] += needR0[i];
    let runoffIncrement = 0;
    for (let i = 0; i < n; i++) {
      need[i] += unmetCarry[i]; unmetCarry[i] = 0;
      const f = E[i].funding; if (!f) continue;
      if (unobs(f.runnable) || unobs(f.runoff)) { flag(`funding:${E[i].id}`, 'entities with unobserved funding profile are excluded from run-off (not assumed stable)'); continue; }
      let ro = f.runoff;
      if (!unobs(f.stressRunoff) && !unobs(f.confidenceThreshold)) { const r = eqRatio(i); if (r !== null && r < f.confidenceThreshold) ro = Math.max(ro, f.stressRunoff); } else if (round === 0) flag(`funding_confidence:${E[i].id}`, 'confidence-driven run-off excluded where stressRunoff/confidenceThreshold unobserved');
      const target = Math.min(f.runnable, ro * opt.runoffScale * f.runnable); const incr = Math.max(0, target - fundingAcc[i]);
      fundingAcc[i] += incr; need[i] += incr; runoffIncrement += incr;
    }
    const paid = zeros(n); const gap = zeros(n);
    for (let i = 0; i < n; i++) { if (!(need[i] > 0)) continue; const c = Math.min(Math.max(0, W.cash[i]), need[i]); W.cash[i] -= c; paid[i] = c; gap[i] = need[i] - c; }
    rec.FUNDING_LIQUIDITY = { totalNeed: sumArr(need), paidFromCash: sumArr(paid), gapAfterCash: sumArr(gap), runoffIncrement };
    // ---------- MARGIN / COLLATERAL on the live prices and live cash
    if (act.has('collateral')) {
      const col = collateralStress(sysC, scenario, { ...collateralParams(system, scenario, options), applyImpact: false }, ixC, W);
      for (const [id, row] of Object.entries(col.soldShares)) { const i = ix.eIdx.get(id); for (const [a, sh] of Object.entries(row)) { const k = ix.aIdx.get(a); W.q[i][k] = Math.max(0, W.q[i][k] - sh); proceeds[i][k] += sh * W.price[k]; } }
      dL.collateral ||= zeros(n); dA.collateral ||= zeros(n);
      for (const row of col.entityCalls) { const i = ix.eIdx.get(row.id); if (!row.defaulted) dL.collateral[i] -= row.repo + row.marginLoan; dL.collateral[i] += row.unmet; }
      imClaims.fill(0); for (const st of W.ns) imClaims[st.i] += Math.max(0, st.postedCash - st.imPosted0);
      col.repoLosses.forEach((l) => { repoLoss[ix.eIdx.get(l.lender)] = Math.max(repoLoss[ix.eIdx.get(l.lender)], l.loss); });
      flag(col.unobserved, col.lowerBoundReasons.join('; ') || null);
      for (const [a, v] of Object.entries(col.roundSalesByAsset[0] ?? {})) { Q[ix.aIdx.get(a)] += v; sellers.collateral += v; }
      rec.MARGIN_COLLATERAL = { called: col.rounds[0]?.called ?? 0, sold: col.rounds[0]?.sold ?? 0, defaulted: col.defaultedEntities };
    }
    // ---------- FORCED ACTION: raise remaining gaps by selling live, unencumbered holdings pro rata
    let forced = 0; let unmetTotal = 0;
    for (let i = 0; i < n; i++) {
      if (!(gap[i] > 0)) continue;
      const vals = []; let tot = 0; for (let k = 0; k < nA; k++) { const v = Math.max(0, W.q[i][k] - W.enc[i][k]) * W.price[k]; vals.push(v); tot += v; }
      const take = Math.min(gap[i], tot);
      if (take > 0) for (let k = 0; k < nA; k++) if (vals[k] > 0) { const sh = (vals[k] / tot) * take / W.price[k]; W.q[i][k] -= sh; proceeds[i][k] += sh * W.price[k]; Q[k] += sh * W.price[k]; sellers.entities += sh * W.price[k]; }
      forced += take; paid[i] += take; unmetCarry[i] = gap[i] - take; unmetTotal += unmetCarry[i]; // proceeds are paid out immediately
    }
    for (let i = 0; i < n; i++) if (paid[i] > 0) { dL.funding ||= zeros(n); dL.funding[i] -= paid[i]; outflowPaid[i] += paid[i]; }
    rec.FORCED_ACTION = { sold: forced, unmetLiquidity: unmetTotal };
    // ---------- MARKET IMPACT: ONE aggregate impact per asset from ALL sellers
    const priceBefore = W.price.slice(); const dImp = zeros(nA);
    for (let k = 0; k < nA; k++) {
      if (!(Q[k] > 0)) continue;
      const imp = priceImpact(system.impact, A[k], Q[k]);
      if (imp === null) { flag(`impact_inputs:${A[k].id}`, 'price impact unobserved for sold assets: impact excluded (never zero); lower bound'); continue; }
      dImp[k] = imp; W.price[k] *= 1 - imp;
    }
    rec.MARKET_IMPACT = { sellers, salesByAsset: Object.fromEntries(A.map((a, k) => [a.id, Q[k]]).filter((x) => x[1] > 0)), priceDeclines: Object.fromEntries(A.map((a, k) => [a.id, dImp[k]]).filter((x) => x[1] > 0)) };
    if (crowd) { // agents' P&L on the realised move; newly triggered agents sell next round
      const fb = crowdingFeedback(crowd, A.map((a, k) => W.price[k] / priceBefore[k] - 1), [], new Set(), round === 0);
      for (let k = 0; k < nA; k++) { const net = sumArr(fb.orders.map((r) => r[k])); if (net < 0) pendingCrowd[k] = -net; }
      crowdLoss = zeros(n); crowd.agents.forEach((a, i) => { if (a.entity) crowdLoss[ix.eIdx.get(a.entity)] += Math.max(0, -crowd.pnlCum[i]); });
    }
    // ---------- COUNTERPARTY / NETWORK CONTAGION (+ CCP default waterfall)
    prop = clr();
    if (act.has('ccp')) {
      const dec = new Set(prop.entities.filter((x) => x.defaulted).map((x) => x.id)); W.defaulted.forEach((d, i) => { if (d) dec.add(E[i].id); });
      const shocksNow = Object.fromEntries(A.map((a, k) => [a.id, Math.min(1, Math.max(0, 1 - W.price[k] / P0[k]))]));
      const res = system.ccps.map((c) => { const mem = new Set(c.members.map((m) => m.entity)); const defs = [...new Set([...(scenario.ccp.defaulters || []), ...dec])].filter((d) => mem.has(d)); return ccpWaterfall(system, c, defs, shocksNow, ix); });
      ccpCharges = zeros(n); for (const r of res) for (const [id, v] of Object.entries(r.memberCharges)) ccpCharges[ix.eIdx.get(id)] += v;
      ccpOut = res; res.forEach((r) => flag(r.unobserved, r.lowerBoundReasons.join('; ') || null));
      prop = clr();
      rec.CCP = { unfundedLoss: sumArr(res.map((r) => r.finalLayers.unfunded)), memberCharges: sumArr(ccpCharges), propagatedDefaults: res.flatMap((r) => r.propagatedDefaults) };
    }
    rec.COUNTERPARTY_NETWORK_CONTAGION = { defaults: prop.system.defaults, waves: prop.system.waves, systemLoss: prop.system.systemLoss };
    // ---------- SECOND ROUND test
    const defaultsNow = new Set(prop.entities.filter((x) => x.defaulted).map((x) => x.id));
    const newDefaults = [...defaultsNow].filter((x) => !prevDefaults.has(x)); prevDefaults = defaultsNow;
    const salesTotal = sumArr(Q); const scale = Math.max(1, sumArr(E.map((e) => e.cash)));
    const pending = sumArr(pendingCrowd) > 1e-9 * scale;
    rec.SECOND_ROUND = { newDefaults, maxPriceMove: Math.max(0, ...A.map((a, k) => Math.abs(W.price[k] / priceBefore[k] - 1))), forcedSalesValue: salesTotal, pendingCrowdingOrders: sumArr(pendingCrowd), unmetLiquidity: unmetTotal };
    trajectory.push({ t: round + 1, label: `STATE(t+${round + 1})`, equityBySector: sectorEquity(prop), defaults: defaultsNow.size, prices: Object.fromEntries(A.map((a, k) => [a.id, W.price[k]])), forcedSales: salesTotal });
    roundsOut.push(rec);
    if (!newDefaults.length && salesTotal <= 1e-9 * scale && !pending) { converged = true; break; }
  }
  trajectory[trajectory.length - 1].label = 'STATE(t+n)';

  // ================= LEDGER: exact value-conservation decomposition of the clearing engine's direct loss (determinate entities)
  const det = prop.entities.map((x) => !x.indeterminate);
  const dAtot = sumDelta(dA); for (let i = 0; i < n; i++) dAtot[i] += imClaims[i] - repoLoss[i] - ccpCharges[i] - crowdLoss[i];
  const holdLossAsset = zeros(nA); let cashOut = 0; let nmHaircut = 0;
  const entShock = scenario.externalShocks || {}; const secShock = scenario.sectorShocks || {};
  for (let i = 0; i < n; i++) {
    if (!det[i]) continue;
    let pr = 0; for (let k = 0; k < nA; k++) { const l = ix.q[i][k] * P0[k] - W.q[i][k] * W.price[k] - proceeds[i][k]; holdLossAsset[k] += l; pr += proceeds[i][k]; }
    cashOut += cash0[i] + pr - W.cash[i];
    const nm0 = (E[i].externalAssets ?? 0) + (E[i].creditBook || []).reduce((s, c) => s + c.amount, 0);
    nmHaircut += nm0 * (1 - (1 - (entShock[E[i].id] ?? 0)) * (1 - (secShock[E[i].sector] ?? 0)));
  }
  let lossExo = 0; let lossImpact = 0; let lossFund = 0;
  for (let k = 0; k < nA; k++) {
    const lt = Math.log(W.price[k] / P0[k]);
    if (!(lt < 0)) { lossImpact += holdLossAsset[k]; continue; }
    const fe = Math.log(1 - Sexo[k]) / lt; const ff = dFund[k] > 0 ? Math.log(1 - dFund[k]) / lt : 0;
    lossExo += holdLossAsset[k] * fe; lossFund += holdLossAsset[k] * ff; lossImpact += holdLossAsset[k] * (1 - fe - ff);
  }
  const detSum = (arr) => arr.reduce((s, v, i) => s + (det[i] ? v : 0), 0);
  const channels = {
    exogenousPriceShocks: lossExo, marketImpact: lossImpact, fundCascadePriceEffect: lossFund, scenarioNonMarketHaircuts: nmHaircut,
    cashSettlements: cashOut, ccpCharges: detSum(ccpCharges), repoLenderLoss: detSum(repoLoss), agentLoss: detSum(crowdLoss), imCashClaims: -detSum(imClaims),
    ...Object.fromEntries(Object.entries(dA).map(([k, v]) => [`assets:${k}`, -detSum(v)])), ...Object.fromEntries(Object.entries(dL).map(([k, v]) => [`liabilities:${k}`, detSum(v)])),
  };
  void dAtot;
  const explained = Object.values(channels).reduce((s, v) => s + v, 0); const sys = prop.system; const scaleL = Math.max(1, sumArr(E.map((e) => e.cash)));
  const reconciliation = { systemLoss: sys.systemLoss, directLoss: sys.directLoss, deadweight: sys.deadweightLoss, explainedByChannels: explained, residual: sys.directLoss - explained, tolerance: 1e-8 * scaleL, reconciled: Math.abs(sys.directLoss - explained) <= 1e-8 * scaleL && sys.reconciled };
  const entities = prop.entities.map((x, i) => ({ ...x, liquidityUnmet: unmetCarry[i], fundingOutflowPaid: outflowPaid[i], marginDefault: W.defaulted[i] }));
  const stages = [
    { stage: 'STATE(t0)', entities: n, equityBySector: trajectory[0].equityBySector, preShockInsolvent: base.entities.filter((x) => x.preShockInsolvent).map((x) => x.id) },
    { stage: 'SHOCK', modules: stage0, exogenousPriceDeclines: Object.fromEntries(A.map((a, k) => [a.id, Sexo[k]]).filter((x) => x[1] > 0)), externalFlowsValue: sumArr(flowsR0) },
    { stage: 'BALANCE_SHEET_EFFECT', ...bsEffect },
    { stage: 'FUNDING_LIQUIDITY', totalPaidOutflows: sumArr(outflowPaid), unmetLiquidity: sumArr(unmetCarry), perRound: roundsOut.map((r) => r.FUNDING_LIQUIDITY) },
    { stage: 'MARGIN_COLLATERAL', active: act.has('collateral'), perRound: roundsOut.map((r) => r.MARGIN_COLLATERAL ?? null) },
    { stage: 'FORCED_ACTION', totalSold: sumArr(roundsOut.map((r) => r.FORCED_ACTION.sold)), perRound: roundsOut.map((r) => r.FORCED_ACTION) },
    { stage: 'MARKET_IMPACT', perRound: roundsOut.map((r) => r.MARKET_IMPACT), finalPriceDeclines: Object.fromEntries(A.map((a, k) => [a.id, 1 - W.price[k] / P0[k]]).filter((x) => x[1] > 1e-15)) },
    { stage: 'COUNTERPARTY_NETWORK_CONTAGION', perRound: roundsOut.map((r) => ({ ...r.COUNTERPARTY_NETWORK_CONTAGION, ccp: r.CCP ?? null })), waves: prop.waves, transmission: prop.transmission, ccp: ccpOut },
    { stage: 'SECOND_ROUND', rounds: roundsOut.length, converged, perRound: roundsOut.map((r) => r.SECOND_ROUND) },
    { stage: 'STATE(t+n)', equityBySector: trajectory[trajectory.length - 1].equityBySector, defaults: sys.defaults, systemLoss: sys.systemLoss },
  ];
  return {
    stages, trajectory, entities, sectors: prop.sectors, waves: prop.waves, system: sys, channels, reconciliation, finalPrices: Object.fromEntries(A.map((a, k) => [a.id, W.price[k]])), converged, rounds: roundsOut.length, activeModules: [...act], dataflow,
    fundCascade: fundCascade ? { totalLoss: fundCascade.value.system.totalLoss, failedFunds: fundCascade.value.system.failedFunds, result_hash: fundCascade.result_hash } : null,
    unobserved: [...unobserved], lowerBoundReasons: [...lowerBound], notes,
  };
}

/** M71 engine wrapper: envelope, uncertainty (seeded Latin-hypercube over assumed twin parameters), failure semantics. */
export function runSystemTwin(system, scenario = {}, options = {}, fundSystem = null) {
  const err = validateTwin(system, scenario, options, fundSystem);
  if (err) return failed(ENGINE, MODEL_ID, err);
  let out;
  try { out = simulateSystem(system, scenario, options, fundSystem); } catch (e) { return failed(ENGINE, MODEL_ID, e?.message || String(e)); }
  let status = STATUS.UNCALIBRATED; const notes = ['Financial System Digital Twin: composition of UNCALIBRATED scenario engines under explicit assumptions. Not a forecast; synthetic tests do not establish predictive validity.', ...out.notes];
  if (!out.converged) { status = STATUS.MODEL_UNCERTAIN; notes.push(`second-round iteration did not converge in ${out.rounds} rounds`); }
  else if (!out.reconciliation.reconciled) { status = STATUS.COMPUTATION_FAILED; notes.push('loss ledger failed to reconcile'); }
  else if (out.unobserved.length) { status = STATUS.INSUFFICIENT_OBSERVABILITY; notes.push('unobserved inputs exclude channels (never zero): totals are lower bounds where flagged'); }
  const p = { alpha: options.alpha ?? 1, beta: options.beta ?? 1, runoffScale: options.runoffScale ?? 1 };
  const u = options.uncertainty ?? {};
  const uncertainty = parameterBand({ evaluate: (pp) => { try { return simulateSystem(system, scenario, { ...options, alpha: Math.min(1, pp.alpha), beta: Math.min(1, pp.beta), runoffScale: pp.runoffScale }, fundSystem).system.systemLoss; } catch { return null; } }, params: p, keys: ['alpha', 'beta', 'runoffScale'], ranges: u.ranges ?? { alpha: [Math.min(p.alpha, 0.7), p.alpha], beta: [Math.min(p.beta, 0.7), p.beta], runoffScale: [0.5, 1.5] }, n: u.n ?? 12, seed: options.seed ?? 1, label: ENGINE });
  const det = out.entities.filter((x) => !x.indeterminate).length;
  return makeResult({
    engine: ENGINE, modelId: MODEL_ID, status,
    value: { stages: out.stages, trajectory: out.trajectory, entities: out.entities, sectors: out.sectors, system: out.system, channels: out.channels, reconciliation: out.reconciliation, finalPrices: out.finalPrices, rounds: out.rounds, activeModules: out.activeModules, models: Object.fromEntries(out.activeModules.map((m) => [m, MODULE_MODELS[m]])), dataflow: out.dataflow, fundCascade: out.fundCascade, lowerBound: out.unobserved.length > 0, lowerBoundReasons: out.lowerBoundReasons },
    uncertainty, coverage: coverageOf(det, system.entities.length), unobserved: out.unobserved, calibration: CALIBRATION.UNCALIBRATED,
    parameters: { ...p, maxRounds: options.maxRounds ?? 20, activeModules: out.activeModules, assumptions: ['sales execute at start-of-round marks; impact falls on remaining holdings (as M10)', 'one aggregate price impact per asset per round from all sellers', 'fund-cascade price effect composed multiplicatively', 'crowding buy-side flows ignored (conservative)', 'operational margin failures reported, not propagated'], scenarioHash: hashOf(scenario) },
    inputHashes: [hashOf(system), ...(fundSystem ? [hashOf(fundSystem)] : [])], notes,
  });
}
