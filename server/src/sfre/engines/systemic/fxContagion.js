import { makeResult, failed, STATUS, CALIBRATION, coverageOf } from '../../core/result.js';
import { hashOf } from '../../core/canonical.js';
import { parameterBand } from '../../core/sensitivity.js';
import { isNum, isNonNeg, isFrac, unobs, probitShift } from '../../core/numeric.js';
import { priceImpact } from '../impact.js';
import { validateSystemState, indexSystem, holdingsValue, sumArr } from './state.js';
import { propagate } from './crossSector.js';

const ENGINE = 'fxContagion';
export const MODEL_ID = 'M61.fx_contagion';

/** Validates system.fx and scenario.fx; returns error string or null. */
export function validateFx(system, scenario) {
  const fx = system.fx;
  if (!fx || typeof fx !== 'object') return 'system.fx required';
  if (!(isNum(fx.spot) && fx.spot > 0)) return 'fx.spot must be > 0 (LCY per FCY)';
  const ids = new Set(system.entities.map((e) => e.id));
  for (const [id, f] of Object.entries(fx.entities || {})) {
    if (!ids.has(id)) return `fx.entities: unknown entity ${id}`;
    for (const k of ['fcyAssets', 'fcyLiabilities']) if (!isNonNeg(f[k])) return `fx.entities.${id}.${k} must be >= 0 (explicit)`;
    for (const k of ['fcyShortTermDebt', 'fcyLiquidAssets']) if (!unobs(f[k]) && !isNonNeg(f[k])) return `fx.entities.${id}.${k} must be null or >= 0`;
    if (!unobs(f.hedgedFraction) && !isFrac(f.hedgedFraction)) return `fx.entities.${id}.hedgedFraction must be null or in [0,1]`;
    if (isNum(f.fcyShortTermDebt) && f.fcyShortTermDebt > f.fcyLiabilities + 1e-9) return `fx.entities.${id}: short-term FCY debt exceeds FCY liabilities`;
  }
  for (const k of ['reserves', 'swapLines']) if (fx.official && !unobs(fx.official[k]) && !isNonNeg(fx.official[k])) return `fx.official.${k} must be null or >= 0`;
  const sc = scenario.fx ?? {};
  if (!unobs(sc.depreciation) && !(isNum(sc.depreciation) && sc.depreciation >= 0 && sc.depreciation <= 1)) return 'scenario.fx.depreciation must be in [0,1]';
  for (const [id, phi] of Object.entries(sc.capitalFlow || {})) {
    const e = system.entities.find((x) => x.id === id);
    if (!e) return `capitalFlow: unknown entity ${id}`;
    if (e.sector !== 'FOREIGN_INVESTOR') return `capitalFlow: ${id} is not a FOREIGN_INVESTOR`;
    if (!isFrac(phi)) return `capitalFlow ${id} must be in [0,1]`;
  }
  for (const [id, r] of Object.entries(sc.rolloverRates || {})) if (!ids.has(id) || !isFrac(r)) return `rolloverRates.${id} invalid`;
  for (const x of system.exposures ?? []) if (x.fxHedged !== undefined && x.fxHedged !== null && !isFrac(x.fxHedged)) return 'exposure.fxHedged must be null or in [0,1]';
  return null;
}

/**
 * Capital flow -> FX liquidity -> exchange-rate shock -> FX debt/balance-sheet effect -> credit/liquidity losses.
 * Amounts of entities are LCY valued at fx.spot. Returns stage table + hand-off deltas for propagate()/the twin.
 * p = {Y, sigma, advValue, usableShare, sensitivity}: the ASSUMED parameters (perturbed by the uncertainty band).
 */
export function fxChain(system, scenario, p, ix = indexSystem(system)) {
  const fx = system.fx; const sc = scenario.fx ?? {}; const { E, n } = ix;
  const unobserved = []; const lb = new Set();
  const priceNow = ix.price;
  // ---- 1) capital flow
  const flows = []; const domesticAssetSales = {};
  let demandFlow = 0;
  for (const [id, phi] of Object.entries(sc.capitalFlow || {})) {
    const i = ix.eIdx.get(id);
    const hv = holdingsValue(ix, i, priceNow).carried;
    const claims = ix.edges.reduce((s, x, e) => (x.c === i && (system.exposures[e].currency ?? 'LCY') === 'LCY' && x.amount !== null ? s + x.amount : s), 0);
    const amount = phi * (hv + claims);
    demandFlow += amount;
    for (let k = 0; k < ix.nA; k++) if (ix.q[i][k] > 0) domesticAssetSales[ix.A[k].id] = (domesticAssetSales[ix.A[k].id] || 0) + phi * ix.q[i][k] * priceNow[k];
    flows.push({ investor: id, portfolioValue: hv + claims, outflowFraction: phi, fcyDemand: amount });
  }
  // ---- 2) FX liquidity
  const gaps = {}; let demandDebt = 0;
  for (const [id, f] of Object.entries(fx.entities || {})) {
    const roll = sc.rolloverRates?.[id] ?? f.rolloverRate;
    if (unobs(f.fcyShortTermDebt) || unobs(roll) || unobs(f.fcyLiquidAssets)) { unobserved.push(`fx_rollover_inputs:${id}`); lb.add('entities with unobserved FCY short-term debt/rollover/liquid assets are excluded from FCY demand'); continue; }
    const gap = Math.max(0, f.fcyShortTermDebt * (1 - roll) - f.fcyLiquidAssets);
    gaps[id] = gap; demandDebt += gap;
  }
  const demand = demandFlow + demandDebt;
  const off = fx.official ?? {};
  let supply = null; let excess = null;
  if (unobs(off.reserves) || unobs(off.swapLines) || unobs(p.usableShare)) { unobserved.push('fx_official_liquidity'); lb.add('official FX liquidity unobserved: endogenous depreciation excluded'); }
  else { supply = off.reserves * p.usableShare + off.swapLines; excess = Math.max(0, demand - supply); }
  // ---- 3) exchange-rate shock
  const d0 = sc.depreciation ?? 0;
  let dEndo = 0;
  if (excess === null) dEndo = 0;
  else if (excess > 0) {
    const imp = priceImpact({ model: 'sqrt', Y: p.Y }, { sigma: p.sigma, advValue: p.advValue }, excess);
    if (imp === null) { unobserved.push('fx_market_impact_inputs'); lb.add('FX market impact parameters (Y, sigma, advValue) unobserved: endogenous depreciation excluded'); } else dEndo = imp;
  }
  const d = Math.min(1, d0 + dEndo);
  // ---- 4) FX debt / balance-sheet effect
  const extAssetsDelta = new Array(n).fill(0); const extLiabDelta = new Array(n).fill(0); const fxEffects = []; let upperExtra = 0;
  for (const [id, f] of Object.entries(fx.entities || {})) {
    const i = ix.eIdx.get(id);
    const h = unobs(f.hedgedFraction) ? 1 : f.hedgedFraction; // point estimate = smallest loss; upper bound below
    if (unobs(f.hedgedFraction)) { unobserved.push(`fx_hedged_fraction:${id}`); lb.add('unobserved hedge ratios: point estimate assumes full hedge (lower bound); upper bound reported'); upperExtra += d * f.fcyLiabilities * 1; }
    extAssetsDelta[i] += d * f.fcyAssets; extLiabDelta[i] += d * f.fcyLiabilities * (1 - h);
    fxEffects.push({ entity: id, assetGain: d * f.fcyAssets, liabilityIncrease: d * f.fcyLiabilities * (1 - h), netLoss: d * f.fcyLiabilities * (1 - h) - d * f.fcyAssets });
  }
  const edgeAmounts = ix.edges.map((x, e) => {
    const raw = system.exposures[e];
    if (x.amount === null || (raw.currency ?? 'LCY') !== 'FCY') return x.amount;
    const hh = unobs(raw.fxHedged) ? 0 : raw.fxHedged; // omitted == explicit-unhedged is NOT assumed: flagged below
    if (unobs(raw.fxHedged)) { unobserved.push(`fx_hedged_fraction:exposure:${raw.creditor}->${raw.debtor}`); lb.add('FCY exposures with unobserved hedge ratio are revalued as unhedged (upper-side treatment flagged)'); }
    return x.amount * (1 + d * (1 - hh));
  });
  // ---- 5) credit losses on FX-sensitive credit books (PD shift; sensitivity must be supplied, else UNOBSERVED not zero)
  let creditLoss = 0; const creditEffects = [];
  for (let i = 0; i < n; i++) for (const c of E[i].creditBook || []) {
    if (!c.fcy) continue;
    if (unobs(p.sensitivity) || unobs(c.pd) || unobs(c.lgd) || unobs(c.fxExposure)) { unobserved.push(`fx_credit_inputs:${E[i].id}:${c.id}`); lb.add('FX-sensitive credit book entries with unobserved pd/lgd/fxExposure/sensitivity are excluded'); continue; }
    const pd1 = probitShift(c.pd, p.sensitivity * d * c.fxExposure);
    const l = c.amount * c.lgd * (pd1 - c.pd);
    extAssetsDelta[i] -= l; creditLoss += l; creditEffects.push({ entity: E[i].id, book: c.id, pd0: c.pd, pd1, loss: l });
  }
  return {
    stages: {
      capitalFlow: { flows, fcyDemand: demandFlow },
      fxLiquidity: { debtRolloverDemand: demandDebt, totalDemand: demand, officialSupply: supply, excessDemand: excess, entityGaps: gaps },
      exchangeRate: { exogenous: d0, endogenous: dEndo, depreciation: d, spot0: fx.spot, spot1: fx.spot * (1 + d) },
      balanceSheet: { effects: fxEffects, netLossSystem: sumArr(fxEffects.map((x) => x.netLoss)) },
      creditLiquidity: { creditLoss, creditEffects, liquidityGapsFcy: gaps },
    },
    handoff: { depreciation: d, extAssetsDelta, extLiabDelta, edgeAmounts, domesticAssetSales, entityFcyGap: gaps },
    unobserved: [...new Set(unobserved)], lowerBoundReasons: [...lb], upperBoundExtraLoss: upperExtra,
  };
}

export function fxParams(system, options = {}) {
  const m = system.fx.market ?? {}; const o = system.fx.official ?? {};
  return { Y: options.Y ?? m.Y ?? null, sigma: m.sigma ?? null, advValue: m.advValue ?? null, usableShare: options.usableShare ?? o.usableShare ?? null, sensitivity: options.pdSensitivity ?? system.fx.pdSensitivity ?? null };
}

/** M61: full chain incl. contagion through the shared network (propagate). */
export function runFxContagion(system, scenario = {}, options = {}) {
  const err = validateSystemState(system, { requireImpact: false }) || validateFx(system, scenario);
  if (err) return failed(ENGINE, MODEL_ID, err);
  const ix = indexSystem(system);
  const p = fxParams(system, options);
  const run = (pp) => {
    const ch = fxChain(system, scenario, pp, ix);
    const prop = propagate(system, {}, { alpha: options.alpha ?? 1, beta: options.beta ?? 1, maxIter: 50000 }, { ix, extAssetsDelta: ch.handoff.extAssetsDelta, extLiabDelta: ch.handoff.extLiabDelta, edgeAmounts: ch.handoff.edgeAmounts });
    return { ch, prop };
  };
  const { ch, prop } = run(p);
  const contagion = prop;
  const unobserved = [...new Set([...ch.unobserved, ...prop.unobserved])];
  let status = STATUS.UNCALIBRATED; const notes = ['FX transmission is a reduced-form scenario model (sqrt market impact, caller-supplied coefficients): UNCALIBRATED, not an exchange-rate forecast.'];
  if (!prop.system.converged) status = STATUS.MODEL_UNCERTAIN;
  else if (!prop.system.reconciled) status = STATUS.COMPUTATION_FAILED;
  else if (unobserved.length) { status = STATUS.INSUFFICIENT_OBSERVABILITY; notes.push('unobserved inputs are excluded (never zero): results are lower bounds where flagged'); }
  const u = options.uncertainty ?? {};
  const uncertainty = parameterBand({ evaluate: (pp) => run({ ...p, ...pp }).prop.system.systemLoss, params: p, keys: ['Y', 'usableShare', 'sensitivity', 'sigma'], ranges: u.ranges ?? {}, n: u.n ?? 24, seed: options.seed ?? 1, label: ENGINE });
  return makeResult({
    engine: ENGINE, modelId: MODEL_ID, status,
    value: { ...ch.stages, contagion, upperBoundHedgeLoss: ch.upperBoundExtraLoss, lowerBound: unobserved.length > 0, handoff: { depreciation: ch.handoff.depreciation, domesticAssetSales: ch.handoff.domesticAssetSales, entityFcyGap: ch.handoff.entityFcyGap } },
    uncertainty, coverage: coverageOf(system.entities.length - prop.entities.filter((x) => x.indeterminate).length, system.entities.length), unobserved, calibration: CALIBRATION.UNCALIBRATED,
    parameters: { ...p, scenario: scenario.fx ?? {}, hedgeAssumption: 'hedges fully effective; counterparty risk of hedges is modelled in M63', additiveShock: 'depreciation = exogenous + endogenous (ASSUMED additive)' },
    inputHashes: [hashOf(system)], notes,
  });
}
