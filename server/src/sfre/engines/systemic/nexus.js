import { makeResult, failed, STATUS, CALIBRATION, coverageOf } from '../../core/result.js';
import { hashOf } from '../../core/canonical.js';
import { parameterBand } from '../../core/sensitivity.js';
import { isNum, isNonNeg, isFrac, unobs, probitShift } from '../../core/numeric.js';
import { validateSystemState, indexSystem, sumArr } from './state.js';
import { propagate } from './crossSector.js';

const ENGINE = 'sovNexus';
export const MODEL_ID = 'M62.sovereign_bank_corporate';
export const MAX_LOOP = 200;
export const MAX_SPREAD = 10; // decimal (100 000 bp): beyond this the doom-loop assumption set is treated as diverged

/** Duration-convexity price factor for a yield change dy (decimal). Floors at 0. */
export const bondPriceFactor = (dur, conv, dy) => Math.max(0, 1 - dur * dy + 0.5 * (conv ?? 0) * dy * dy);

export function validateNexus(system, scenario) {
  const s = system.sovereign;
  if (!s || typeof s !== 'object') return 'system.sovereign required';
  const aset = (system.assets ?? []).find((a) => a.id === s.bondAsset);
  if (!aset) return 'sovereign.bondAsset must reference a system asset';
  if (!(isNum(s.debt) && s.debt > 0) || !(isNum(s.gdp) && s.gdp > 0)) return 'sovereign.debt and sovereign.gdp must be > 0';
  for (const k of ['passThrough', 'pdSensitivity', 'creditCrunchPdSensitivity', 'capitalCostSensitivity', 'spreadPerDebtGdpPp', 'growthSensitivity']) if (!unobs(s[k]) && !(isNum(s[k]) && s[k] >= 0)) return `sovereign.${k} must be null or >= 0`;
  if (!unobs(s.backstopShare) && !isFrac(s.backstopShare)) return 'sovereign.backstopShare must be null or in [0,1]';
  const sc = scenario.sovereign ?? {};
  if (!(isNum(sc.spreadShockBps) && sc.spreadShockBps >= 0 && sc.spreadShockBps <= 20000)) return 'scenario.sovereign.spreadShockBps must be in [0, 20000]';
  for (const e of system.entities) {
    const b = e.bank; if (!b) continue;
    if (!unobs(b.rwa) && !(isNum(b.rwa) && b.rwa > 0)) return `entity ${e.id}: bank.rwa must be null or > 0`;
    if (!unobs(b.minCapitalRatio) && !(isNum(b.minCapitalRatio) && b.minCapitalRatio > 0 && b.minCapitalRatio < 1)) return `entity ${e.id}: bank.minCapitalRatio must be in (0,1)`;
    if (!unobs(b.corporateRwaShare) && !isFrac(b.corporateRwaShare)) return `entity ${e.id}: bank.corporateRwaShare must be in [0,1]`;
  }
  for (const e of system.entities) {
    const c = e.corporate; if (!c) continue;
    if (!isNonNeg(c.floatingDebt)) return `entity ${e.id}: corporate.floatingDebt must be >= 0`;
  }
  for (const e of system.entities) for (const c of e.creditBook || []) if (c.riskSector === 'CORPORATE' && !unobs(c.debtToEbitda) && !(isNum(c.debtToEbitda) && c.debtToEbitda >= 0)) return `entity ${e.id}: creditBook ${c.id} debtToEbitda must be null or >= 0`;
  return null;
}

/**
 * One evaluation of the sovereign-bank-corporate loop (fixed point on the sovereign yield shock).
 * p = assumed parameters (perturbed by the uncertainty band).  Returns plain data.
 */
export function nexusLoop(system, scenario, p, options = {}, ix = indexSystem(system), pre = null) {
  const s = system.sovereign; const { E, n } = ix;
  const bond = ix.A[ix.aIdx.get(s.bondAsset)]; const bk = ix.aIdx.get(s.bondAsset);
  const dur = bond.duration; const conv = bond.convexity ?? 0; // null convexity: second-order term omitted -> flagged below (never silently zero)
  const unobserved = []; const lb = new Set();
  if (unobs(dur)) return { error: `bond asset ${bond.id} needs duration` };
  for (const k of ['passThrough', 'pdSensitivity', 'creditCrunchPdSensitivity', 'capitalCostSensitivity', 'spreadPerDebtGdpPp', 'backstopShare', 'growthSensitivity']) if (unobs(p[k])) { unobserved.push(`nexus_param:${k}`); lb.add(`parameter ${k} unobserved: its channel is excluded (not set to zero effect silently; result is a lower bound)`); }
  const has = (k) => !unobs(p[k]);
  if (unobs(bond.convexity)) { unobserved.push(`bond_convexity:${bond.id}`); lb.add('bond convexity unobserved: second-order price term omitted (price loss overstated)'); }
  const horizon = options.horizonYears ?? 1;
  const dy0 = scenario.sovereign.spreadShockBps / 1e4;
  const banks = E.map((e, i) => ({ e, i })).filter((x) => x.e.bank);
  banks.forEach(({ e }) => { if (unobs(e.bank.corporateRwaShare)) { unobserved.push(`corporate_rwa_share:${e.id}`); lb.add('banks with unobserved corporate RWA share: credit-crunch channel excluded'); } if (unobs(e.bank.rwa) || unobs(e.bank.minCapitalRatio)) { unobserved.push(`bank_capital_inputs:${e.id}`); lb.add('banks with unobserved RWA/minimum ratio are excluded from the capital/credit-supply channel'); } });
  const base = propagate(system, {}, { alpha: 1, beta: 1, maxIter: 50000 }, { ix });
  const eq0 = base.entities.map((x) => x.equity0);

  let dy = dy0; let prevShort = new Array(n).fill(0); const trace = []; let converged = false; let last = null; let divergedAt = null;
  const hist = [];
  for (let it = 0; it < MAX_LOOP; it++) {
    const f = bondPriceFactor(dur, conv, dy);
    // corporate refinancing-cost increase seen by each bank's corporate borrowers
    const dc = new Array(n).fill(0); const crunch = new Array(n).fill(0);
    for (const { e, i } of banks) {
      const rwa = e.bank.rwa;
      const sr = !unobs(rwa) && rwa > 0 ? prevShort[i] / rwa : 0;
      dc[i] = (has('passThrough') ? p.passThrough * dy : 0) + (has('capitalCostSensitivity') ? p.capitalCostSensitivity * sr : 0);
      if (!unobs(rwa) && !unobs(e.bank.minCapitalRatio) && !unobs(e.bank.corporateRwaShare) && has('creditCrunchPdSensitivity')) crunch[i] = Math.min(1, prevShort[i] / e.bank.minCapitalRatio / rwa) * e.bank.corporateRwaShare;
    }
    const delta = new Array(n).fill(0); const elByBank = new Array(n).fill(0); const pdShifts = [];
    for (const { e, i } of banks) for (const c of e.creditBook || []) {
      if (c.riskSector !== 'CORPORATE') continue;
      if (unobs(c.pd) || unobs(c.lgd) || unobs(c.debtToEbitda)) { unobserved.push(`nexus_credit_inputs:${e.id}:${c.id}`); lb.add('corporate credit book entries with unobserved pd/lgd/debtToEbitda are excluded'); continue; }
      const shift = (has('pdSensitivity') ? p.pdSensitivity * dc[i] * c.debtToEbitda : 0) + (has('creditCrunchPdSensitivity') ? p.creditCrunchPdSensitivity * crunch[i] : 0);
      const pd1 = probitShift(c.pd, shift);
      const l = c.amount * c.lgd * (pd1 - c.pd);
      elByBank[i] += l; delta[i] -= l; pdShifts.push({ bank: e.id, book: c.id, pd0: c.pd, pd1, shift, loss: l });
    }
    // corporate entities: earnings hit on floating-rate debt (assumed horizon), structural channel into the network
    let corpEarnings = 0;
    E.forEach((e, i) => { if (e.corporate) { const l = (has('passThrough') ? p.passThrough * dy : 0) * e.corporate.floatingDebt * horizon; delta[i] -= l; corpEarnings += l; } });
    // `pre` = effects of OTHER engines already applied by the Digital Twin (climate, FX, ...): the loop sees total bank losses
    const shocks = { ...(pre?.priceShocks ?? {}) }; shocks[bond.id] = 1 - (1 - (shocks[bond.id] ?? 0)) * f;
    const totalDelta = delta.map((v, i) => v + (pre?.extAssetsDelta?.[i] ?? 0));
    const prop = propagate(system, { priceShocks: shocks }, { alpha: 1, beta: 1, maxIter: 50000 }, { ix, extAssetsDelta: totalDelta, extLiabDelta: pre?.extLiabDelta, edgeAmounts: pre?.edgeAmounts });
    // accounting equity: HTM losses are not recognised (reported separately)
    const short = new Array(n).fill(0); let sumShort = 0; let crunchW = 0; let rwaTot = 0; let htmUnrealised = 0;
    const bankRows = banks.map(({ e, i }) => {
      const ent = prop.entities[i]; const htmQ = ix.htm[i][bk]; const htmLoss = htmQ * bond.price * (1 - f);
      htmUnrealised += htmLoss;
      const acct = ent.defaulted ? 0 : ent.equityFinal + htmLoss;
      const rwa = e.bank.rwa; const m = e.bank.minCapitalRatio;
      let sh = null; let ratio = null;
      if (!unobs(rwa) && !unobs(m)) { sh = Math.max(0, m * rwa - acct); ratio = acct / rwa; short[i] = sh; sumShort += sh; crunchW += crunch[i] * rwa; rwaTot += rwa; }
      return { id: e.id, equity0: eq0[i], equityEconomic: ent.equityFinal, equityAccounting: acct, capitalRatio: ratio, capitalShortfall: sh, defaulted: ent.defaulted, htmUnrealisedLoss: htmLoss, creditELIncrease: elByBank[i], corporateFundingCostIncrease: dc[i] };
    });
    // sovereign feedback
    let dyNext = dy0; const debtGdp0 = s.debt / s.gdp; let backstop = 0; let gdp1 = s.gdp;
    if (has('backstopShare')) { backstop = p.backstopShare * sumShort; }
    if (has('growthSensitivity') && rwaTot > 0) gdp1 = s.gdp * (1 - Math.min(1, p.growthSensitivity * (crunchW / rwaTot)));
    const gdpOk = gdp1 > 1e-9 * s.gdp; // GDP wiped out by the credit-crunch assumption: debt/GDP undefined -> diverged
    const debtGdp1 = gdpOk ? (s.debt + backstop) / gdp1 : null;
    if (gdpOk && has('spreadPerDebtGdpPp')) dyNext = dy0 + (p.spreadPerDebtGdpPp * 100 * (debtGdp1 - debtGdp0)) / 1e4;
    const diverged = !gdpOk || !Number.isFinite(dyNext) || dyNext > MAX_SPREAD;
    last = { f, bankRows, pdShifts, corpEarnings, sumShort, backstop, gdp1, debtGdp0, debtGdp1, prop, delta, htmUnrealised, crunch };
    trace.push({ iteration: it + 1, spreadBps: dy * 1e4, bondPriceFactor: f, bankCapitalShortfall: sumShort, corporateELIncrease: sumArr(elByBank), sovereignBackstop: backstop, debtGdp: debtGdp1 });
    hist.push(dy);
    prevShort = short;
    if (diverged) { divergedAt = it + 1; break; } // keep the last FINITE iterate; the result is reported MODEL_UNCERTAIN
    if (Math.abs(dyNext - dy) < 1e-13) { converged = true; dy = dyNext; break; }
    dy = dyNext;
  }
  const d1 = hist.length >= 3 ? Math.abs(hist[hist.length - 1] - hist[hist.length - 2]) : null; const d0 = hist.length >= 3 ? Math.abs(hist[hist.length - 2] - hist[hist.length - 3]) : null;
  return {
    converged, divergedAt, iterations: trace.length, trace, spreadBps0: dy0 * 1e4, spreadBpsFinal: dy * 1e4, amplification: dy0 > 0 ? dy / dy0 : null,
    contractionRatio: d1 !== null && d0 > 0 ? d1 / d0 : null, last, unobserved: [...new Set(unobserved)], lowerBoundReasons: [...lb],
    firstRound: { spreadBps: dy0 * 1e4, bankCapitalShortfall: trace[0].bankCapitalShortfall, corporateELIncrease: trace[0].corporateELIncrease, debtGdp: trace[0].debtGdp },
  };
}

export function nexusParams(system, options = {}) {
  const s = system.sovereign; const o = options.params ?? {};
  const g = (k) => (o[k] !== undefined ? o[k] : (s[k] ?? null));
  return { passThrough: g('passThrough'), pdSensitivity: g('pdSensitivity'), creditCrunchPdSensitivity: g('creditCrunchPdSensitivity'), capitalCostSensitivity: g('capitalCostSensitivity'), spreadPerDebtGdpPp: g('spreadPerDebtGdpPp'), backstopShare: g('backstopShare'), growthSensitivity: g('growthSensitivity') };
}

/** M62 Sovereign-bank-corporate nexus: spread shock -> bank B/S -> funding & credit conditions -> corporate PD/loss -> sovereign backstop -> spread. */
export function runSovNexus(system, scenario = {}, options = {}) {
  const err = validateSystemState(system) || validateNexus(system, scenario);
  if (err) return failed(ENGINE, MODEL_ID, err);
  const ix = indexSystem(system);
  const p = nexusParams(system, options);
  const out = nexusLoop(system, scenario, p, options, ix);
  if (out.error) return failed(ENGINE, MODEL_ID, out.error);
  const { last, ...core } = out; const { prop, delta, ...lastView } = last;
  const contagion = prop;
  const unobserved = [...new Set([...out.unobserved, ...prop.unobserved])];
  let status = STATUS.UNCALIBRATED; const notes = ['Reduced-form feedback loop with caller-supplied sensitivities: UNCALIBRATED scenario model, not a sovereign-risk forecast.'];
  if (!out.converged) { status = STATUS.MODEL_UNCERTAIN; if (out.divergedAt) notes.push(`loop DIVERGED at iteration ${out.divergedAt} (spread/GDP feedback unbounded under these assumptions); the last finite iterate is shown`); notes.push(`loop did not converge in ${MAX_LOOP} iterations (contraction ratio ${out.contractionRatio ?? 'n/a'}): the doom-loop assumption set is unstable`); }
  else if (!prop.system.reconciled) status = STATUS.COMPUTATION_FAILED;
  else if (unobserved.length) { status = STATUS.INSUFFICIENT_OBSERVABILITY; notes.push('unobserved parameters/inputs exclude channels: lower bound'); }
  const u = options.uncertainty ?? {};
  const uncertainty = parameterBand({ evaluate: (pp) => { const r = nexusLoop(system, scenario, { ...p, ...pp }, options, ix); return r.error ? null : r.spreadBpsFinal; }, params: p, keys: Object.keys(p), ranges: u.ranges ?? {}, n: u.n ?? 16, seed: options.seed ?? 1, label: ENGINE });
  const det = prop.entities.filter((x) => !x.indeterminate).length;
  return makeResult({
    engine: ENGINE, modelId: MODEL_ID, status,
    value: { ...core, banks: lastView.bankRows, pdShifts: lastView.pdShifts, sovereign: { debtGdp0: lastView.debtGdp0, debtGdp1: lastView.debtGdp1, backstop: lastView.backstop, gdp1: lastView.gdp1 }, htmUnrealisedLoss: lastView.htmUnrealised, bondPriceFactor: lastView.f, contagion, lowerBound: unobserved.length > 0,
      handoff: { priceShocks: { [system.sovereign.bondAsset]: 1 - lastView.f }, extAssetsDelta: delta, creditSupplyContraction: Object.fromEntries(system.entities.map((e, i) => [e.id, lastView.crunch[i]]).filter((x) => x[1] > 0)) } },
    uncertainty, coverage: coverageOf(det, system.entities.length), unobserved, calibration: CALIBRATION.UNCALIBRATED,
    parameters: { ...p, spreadShockBps: scenario.sovereign.spreadShockBps, horizonYears: options.horizonYears ?? 1, bondValuation: 'duration-convexity second order', htm: 'HTM losses unrecognised in accounting capital; recognised economically' },
    inputHashes: [hashOf(system)], notes,
  });
}
