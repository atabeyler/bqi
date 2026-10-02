import { makeResult, failed, STATUS, CALIBRATION, coverageOf } from '../../core/result.js';
import { hashOf } from '../../core/canonical.js';
import { parameterBand } from '../../core/sensitivity.js';
import { isFrac, unobs } from '../../core/numeric.js';
import { validateSystemState, indexSystem, holdingsValue, sumArr, SECTORS } from './state.js';
import { clearNetwork } from './clearing.js';

const ENGINE = 'crossSector';
export const MODEL_ID = 'M60.cross_sector';

/**
 * Pure computation of one cross-sector propagation (no envelope). Used by the standalone engine and re-used
 * (not re-implemented) by the Financial System Digital Twin for its network-contagion stage.
 *  ctx.extAssetsDelta[i]  signed change (LCY) of entity i's external assets caused by other engines (FX revaluation, climate, ...)
 *  ctx.extLiabDelta[i]    signed change of entity i's liabilities outside the network
 *  ctx.transferDelta[i]   signed change of external assets that merely TRANSFERS a loss already counted elsewhere (e.g. an investor's
 *                         stake in a fund whose assets already lost the value): hits the entity's equity but is NOT value destroyed
 *  ctx.edgeAmounts[e]     revalued amount of exposure e (aligned with system.exposures); default = nominal
 *  ctx.work               {cash[], q[][], price[]}: live working state of the Digital Twin (sales already executed, current marks);
 *                         when given, holdings/cash/prices are read from it instead of system + scenario.priceShocks
 *  Direct loss = external-asset value lost + outside-liability increase (so the conservation identity holds for any combination).
 */
export function propagate(system, scenario, { alpha, beta, maxIter }, ctx = {}) {
  const ix = ctx.ix ?? indexSystem(system);
  const { E, n } = ix;
  const w = ctx.work ?? null;
  const price = w ? w.price.slice() : ix.price.slice();
  const shocks = w ? {} : (scenario.priceShocks || {});
  for (const [id, s] of Object.entries(shocks)) { const k = ix.aIdx.get(id); price[k] *= 1 - s; }
  const unobserved = []; const lowerBoundReasons = new Set();
  const indeterminate = new Array(n).fill(false);
  const sectorShock = scenario.sectorShocks || {}; const entShock = scenario.externalShocks || {};

  const ext0 = new Array(n).fill(0); const ext = new Array(n).fill(0); const direct = new Array(n).fill(0);
  const dA = ctx.extAssetsDelta ?? new Array(n).fill(0); const dL = ctx.extLiabDelta ?? new Array(n).fill(0); const dT = ctx.transferDelta ?? new Array(n).fill(0);
  E.forEach((e, i) => {
    if (unobs(e.externalAssets)) { indeterminate[i] = true; unobserved.push(`externalAssets:${e.id}`); lowerBoundReasons.add('entities with unobserved external assets are excluded from the network'); }
    if (unobs(e.externalLiabilities)) { indeterminate[i] = true; unobserved.push(`externalLiabilities:${e.id}`); lowerBoundReasons.add('entities with unobserved external liabilities are excluded from the network'); }
    const base = holdingsValue(ix, i, ix.A.map((a) => a.price)); // pre-shock economic value
    const after = w ? { market: w.q[i].reduce((sum, qty, k) => sum + qty * price[k], 0), htmMark: 0 } : holdingsValue(ix, i, price);
    const cashAfter = w ? w.cash[i] : e.cash;
    const credit0 = (e.creditBook || []).reduce((s, c) => s + c.amount, 0);
    const nonMarket0 = (e.externalAssets ?? 0) + credit0;
    const h = 1 - (1 - (entShock[e.id] ?? 0)) * (1 - (sectorShock[e.sector] ?? 0));
    const nonMarket = nonMarket0 * (1 - h);
    ext0[i] = e.cash + base.market + base.htmMark + nonMarket0;
    ext[i] = cashAfter + after.market + after.htmMark + nonMarket + dA[i] + dT[i];
    direct[i] = ext0[i] - ext[i] + dL[i] + dT[i]; // transfers are excluded from value destroyed
  });

  // edges: known amounts only, between determinate entities
  const edges = [];
  ix.edges.forEach((x, e) => {
    if (indeterminate[x.c] || indeterminate[x.d]) return;
    if (x.amount === null) { unobserved.push(`exposure:${E[x.c].id}->${E[x.d].id}`); lowerBoundReasons.add('exposures with unobserved amount are excluded'); return; }
    edges.push({ ...x, nominal: x.amount, amount: ctx.edgeAmounts ? ctx.edgeAmounts[e] : x.amount });
  });
  const extLiab0 = E.map((e, i) => (indeterminate[i] ? 0 : e.externalLiabilities));
  // Net external position is preserved exactly: a negative external-asset balance (losses beyond the entity's assets) becomes a liability
  // to outside creditors, a negative outside-liability balance (over-repayment) becomes an asset. Clipping would silently destroy value.
  const extLiab = new Array(n).fill(0); const extEff = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (indeterminate[i]) continue;
    let L = extLiab0[i] + dL[i]; let a = ext[i];
    if (a < 0) { L -= a; a = 0; }
    if (L < 0) { a -= L; L = 0; }
    extLiab[i] = L; extEff[i] = a;
  }
  // determinate sub-network
  const det = []; for (let i = 0; i < n; i++) if (!indeterminate[i]) det.push(i);
  const map = new Map(det.map((g, l) => [g, l]));
  const sub = {
    n: det.length, ext: det.map((g) => extEff[g]), extLiab: det.map((g) => extLiab[g]),
    edges: edges.map((x) => ({ c: map.get(x.c), d: map.get(x.d), amount: x.amount })), alpha, beta, maxIter,
  };
  const clr = clearNetwork(sub);

  // per-entity accounting
  const outEdges = new Array(n).fill(0).map(() => []); // claims held by creditor
  const inNominal = new Array(n).fill(0); // pre-shock nominal liabilities to the network
  for (const x of edges) { outEdges[x.c].push(x); inNominal[x.d] += x.nominal; }
  const entities = E.map((e, i) => {
    if (indeterminate[i]) return { id: e.id, sector: e.sector, indeterminate: true, equity0: null, equityFinal: null, defaulted: null, wave: null };
    const l = map.get(i);
    const claimsFace = outEdges[i].reduce((s, x) => s + x.amount, 0);
    let claimsRecv = 0;
    for (const x of outEdges[i]) { const dl = map.get(x.d); claimsRecv += clr.Lbar[dl] > 0 ? x.amount * (clr.p[dl] / clr.Lbar[dl]) : x.amount; }
    const equity0 = ext0[i] + outEdges[i].reduce((s, x) => s + x.nominal, 0) - (extLiab0[i] + inNominal[i]);
    return {
      id: e.id, sector: e.sector, indeterminate: false, equity0, equityFinal: clr.equity[l], defaulted: clr.defaulted[l], wave: clr.wave[l],
      nominalLiabilities: clr.Lbar[l], paid: clr.p[l], recoveryRate: clr.Lbar[l] > 0 ? clr.p[l] / clr.Lbar[l] : null,
      direct: direct[i], creditLossOnClaims: claimsFace - claimsRecv, shortfallToCreditors: clr.Lbar[l] - clr.p[l], preShockInsolvent: equity0 < 0,
    };
  });

  // conservation identity: value destroyed = equity loss + outside-creditor loss
  const detE = entities.filter((x) => !x.indeterminate);
  const directLoss = sumArr(detE.map((x) => x.direct));
  const deadweight = sumArr(clr.deadweight);
  const outsidePay = sumArr(det.map((g, l) => (clr.Lbar[l] > 0 ? clr.p[l] * (extLiab[g] / clr.Lbar[l]) : 0)));
  const outsideNominal = sumArr(det.map((g) => extLiab[g]));
  const equityLoss = sumArr(detE.map((x) => x.equity0 - x.equityFinal));
  const outsideLoss = outsideNominal - outsidePay;
  const transferLoss = -sumArr(det.map((g) => dT[g]));
  const identityResidual = (directLoss + deadweight + transferLoss) - (equityLoss + outsideLoss);
  const scale = Math.max(1, sumArr(det.map((g) => ext0[g])));

  // sector aggregates + cross-sector transmission matrix (debtor sector -> creditor sector shortfall)
  const sectors = {}; for (const s of SECTORS) sectors[s] = { entities: 0, equity0: 0, equityFinal: 0, equityLoss: 0, defaults: 0 };
  for (const x of detE) { const s = sectors[x.sector]; s.entities++; s.equity0 += x.equity0; s.equityFinal += x.equityFinal; s.equityLoss += x.equity0 - x.equityFinal; if (x.defaulted) s.defaults++; }
  const transmission = {};
  for (const x of edges) {
    const dl = map.get(x.d); const f = clr.Lbar[dl] > 0 ? 1 - clr.p[dl] / clr.Lbar[dl] : 0; if (!(f > 0)) continue;
    const ds = E[x.d].sector; const cs = E[x.c].sector; transmission[ds] ||= {}; transmission[ds][cs] = (transmission[ds][cs] || 0) + x.amount * f;
  }
  const waves = [];
  for (let w = 1; w <= clr.waves; w++) {
    const members = detE.filter((x) => x.wave === w);
    waves.push({ wave: w, defaulted: members.map((x) => ({ id: x.id, sector: x.sector })), shortfallToCreditors: sumArr(members.map((x) => x.shortfallToCreditors)) });
  }
  const systemLoss = directLoss + deadweight;
  return {
    entities, waves, sectors: Object.fromEntries(Object.entries(sectors).filter(([, v]) => v.entities > 0)), transmission,
    system: {
      directLoss, deadweightLoss: deadweight, systemLoss, transferLoss, equityLoss, outsideCreditorLoss: outsideLoss, identityResidual, identityTolerance: 1e-9 * scale,
      reconciled: Math.abs(identityResidual) <= 1e-9 * scale, defaults: detE.filter((x) => x.defaulted).length, waves: clr.waves,
      amplification: directLoss > 0 ? (equityLoss + outsideLoss) / directLoss : null, converged: clr.converged, iterations: clr.iterations,
    },
    finalPrices: Object.fromEntries(ix.A.map((a, k) => [a.id, price[k]])),
    clearing: { alpha, beta }, unobserved: [...new Set(unobserved)], lowerBound: lowerBoundReasons.size > 0, lowerBoundReasons: [...lowerBoundReasons],
  };
}

/** Validates scenario fractions; returns error string or null. */
export function validateScenario(system, scenario) {
  const ids = new Set(system.entities.map((e) => e.id)); const aids = new Set((system.assets ?? []).map((a) => a.id));
  for (const [k, s] of Object.entries(scenario.priceShocks || {})) { if (!aids.has(k)) return `price shock on unknown asset ${k}`; if (!isFrac(s)) return `price shock ${k} must be in [0,1]`; }
  for (const [k, s] of Object.entries(scenario.externalShocks || {})) { if (!ids.has(k)) return `external shock on unknown entity ${k}`; if (!isFrac(s)) return `external shock ${k} must be in [0,1]`; }
  for (const [k, s] of Object.entries(scenario.sectorShocks || {})) { if (!SECTORS.includes(k)) return `sector shock on unknown sector ${k}`; if (!isFrac(s)) return `sector shock ${k} must be in [0,1]`; }
  return null;
}

/**
 * M60 Systemwide / cross-sector stress. Banks, funds, insurers, corporates, sovereign, households and foreign investors
 * share ONE balance-sheet/exposure network; a shock propagates through successive default waves (2nd, 3rd ... round).
 * scenario: {priceShocks:{asset:frac}, externalShocks:{entityId:frac}, sectorShocks:{SECTOR:frac}}
 * options:  {alpha, beta} recovery of external/network assets of a defaulter (bankruptcy costs; ASSUMED, default 1 = no costs),
 *           {uncertainty:{n, ranges}}
 */
export function runCrossSector(system, scenario = {}, options = {}) {
  const err = validateSystemState(system) || validateScenario(system, scenario);
  if (err) return failed(ENGINE, MODEL_ID, err);
  const alpha = options.alpha ?? 1; const beta = options.beta ?? 1;
  if (!isFrac(alpha) || !isFrac(beta)) return failed(ENGINE, MODEL_ID, 'alpha and beta must be in [0,1]');
  const maxIter = Math.min(200000, Math.max(1, options.maxIter ?? 50000)); // request-controlled: clamped
  const ix = indexSystem(system);
  const core = propagate(system, scenario, { alpha, beta, maxIter }, { ix });
  const value = core;
  let status = STATUS.UNCALIBRATED; const notes = ['Scenario output under stated assumptions; parameters are UNCALIBRATED. Not a forecast of any real-world outcome.'];
  if (!core.system.converged) { status = STATUS.MODEL_UNCERTAIN; notes.push('clearing iteration did not converge'); }
  else if (!core.system.reconciled) { status = STATUS.COMPUTATION_FAILED; notes.push('value-conservation identity failed'); }
  else if (core.unobserved.length) { status = STATUS.INSUFFICIENT_OBSERVABILITY; notes.push('unobserved entities/exposures are excluded: results are lower bounds'); }
  const k = options.uncertainty ?? {};
  const uncertainty = parameterBand({
    evaluate: (p) => propagate(system, scenario, { alpha: Math.min(1, Math.max(0, p.alpha)), beta: Math.min(1, Math.max(0, p.beta)), maxIter }, { ix }).system.systemLoss,
    params: { alpha, beta }, keys: ['alpha', 'beta'], ranges: k.ranges ?? { alpha: [Math.min(alpha, 0.7), alpha], beta: [Math.min(beta, 0.7), beta] }, n: k.n ?? 24, seed: options.seed ?? 1, label: ENGINE,
  });
  const det = value.entities.filter((x) => !x.indeterminate).length;
  return makeResult({
    engine: ENGINE, modelId: MODEL_ID, status, value, uncertainty,
    coverage: coverageOf(det, system.entities.length), unobserved: value.unobserved, calibration: CALIBRATION.UNCALIBRATED,
    parameters: { alpha, beta, alphaBetaBasis: options.alpha === undefined ? 'ASSUMED_NO_BANKRUPTCY_COSTS' : 'CALLER', maxIter, shocks: scenario, assumptions: ['limited liability', 'pro-rata payment to creditors', 'greatest clearing vector (Rogers-Veraart)'] },
    inputHashes: [hashOf(system)], notes,
  });
}
