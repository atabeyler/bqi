import { makeResult, failed, STATUS, CALIBRATION, coverageOf } from '../../core/result.js';
import { hashOf } from '../../core/canonical.js';
import { parameterBand } from '../../core/sensitivity.js';
import { isNonNeg, isFrac, unobs, probitShift } from '../../core/numeric.js';
import { validateSystemState, indexSystem, sumArr } from './state.js';
import { propagate } from './crossSector.js';

const ENGINE = 'climate';
export const MODEL_ID = 'M68.climate_nature';

export function validateClimate(system, scenario) {
  const c = system.climate;
  if (!c || typeof c !== 'object') return 'system.climate required';
  if (!c.sectors || !Object.keys(c.sectors).length) return 'climate.sectors required';
  for (const [s, v] of Object.entries(c.sectors)) {
    for (const k of ['emissionIntensity', 'ebitdaMargin', 'physicalAssetShare']) if (!unobs(v[k]) && !isNonNeg(v[k])) return `climate.sectors.${s}.${k} must be null or >= 0`;
    if (!unobs(v.ebitdaMargin) && v.ebitdaMargin <= 0) return `climate.sectors.${s}.ebitdaMargin must be > 0`;
    if (!unobs(v.physicalAssetShare) && v.physicalAssetShare > 1) return `climate.sectors.${s}.physicalAssetShare must be <= 1`;
    for (const [svc, d] of Object.entries(v.natureDependency || {})) if (!isFrac(d)) return `climate.sectors.${s}.natureDependency.${svc} must be in [0,1]`;
  }
  for (const [k, v] of Object.entries(c.parameters || {})) if (!unobs(v) && !isNonNeg(v)) return `climate.parameters.${k} must be null or >= 0`;
  const aIds = new Set((system.assets ?? []).map((a) => a.id));
  for (const [a, s] of Object.entries(c.assetSector || {})) if (!aIds.has(a) || !c.sectors[s]) return `climate.assetSector ${a}->${s} invalid`;
  for (const e of system.entities) if (e.riskSector !== undefined && !c.sectors[e.riskSector]) return `entity ${e.id}: riskSector ${e.riskSector} not in climate.sectors`;
  for (const e of system.entities) for (const b of e.creditBook || []) if (b.riskSector !== undefined && b.riskSector !== 'CORPORATE' && !c.sectors[b.riskSector]) return `entity ${e.id}: creditBook ${b.id} riskSector ${b.riskSector} not in climate.sectors`;
  for (const [id, m] of Object.entries(c.insurers || {})) { if (!system.entities.some((e) => e.id === id && e.sector === 'INSURER')) return `climate.insurers.${id}: not an INSURER entity`; for (const [s, sh] of Object.entries(m)) if (!c.sectors[s] || !isFrac(sh)) return `climate.insurers.${id}.${s} invalid`; }
  const sc = scenario.climate ?? {};
  const t = sc.transition; if (t && (!isNonNeg(t.carbonPrice) || !isFrac(t.passThrough) || !isFrac(t.abatement))) return 'scenario.climate.transition needs carbonPrice>=0, passThrough and abatement in [0,1]';
  for (const [s, d] of Object.entries(sc.physical?.damageRatio || {})) if (!c.sectors[s] || !isFrac(d)) return `physical.damageRatio.${s} invalid`;
  for (const d of Object.values(sc.nature?.degradation || {})) if (!isFrac(d)) return 'nature.degradation must be in [0,1]';
  if (!t && !sc.physical && !sc.nature) return 'scenario.climate needs at least one of transition|physical|nature';
  return null;
}

/** Sector transmission: transition + nature -> EBITDA drop -> valuation haircut & PD shift; physical -> asset damage (insured/uninsured). */
export function climateSectors(system, scenario, p) {
  const c = system.climate; const sc = scenario.climate ?? {}; const unobserved = []; const lb = new Set(); const out = {};
  for (const [s, v] of Object.entries(c.sectors)) {
    let tCost = 0; let natLoss = 0; let phys = 0; const row = { channels: {} };
    if (sc.transition) {
      if (unobs(v.emissionIntensity)) { unobserved.push(`emission_intensity:${s}`); lb.add('sectors with unobserved emission intensity are excluded from the transition channel'); row.channels.transition = 'UNOBSERVED'; }
      else { tCost = sc.transition.carbonPrice * v.emissionIntensity * (1 - sc.transition.abatement) * (1 - sc.transition.passThrough); row.channels.transition = tCost; }
    }
    if (sc.nature) {
      const deps = Object.entries(v.natureDependency || {});
      if (!deps.length) { unobserved.push(`nature_dependency:${s}`); lb.add('sectors without nature-dependency data are excluded from the nature channel'); row.channels.nature = 'UNOBSERVED'; }
      else { natLoss = 1 - deps.reduce((pr, [svc, d]) => pr * (1 - d * (sc.nature.degradation[svc] ?? 0)), 1); row.channels.nature = natLoss; }
    }
    let ebitdaDrop = 0;
    if (tCost > 0 || natLoss > 0) {
      if (unobs(v.ebitdaMargin)) { unobserved.push(`ebitda_margin:${s}`); lb.add('sectors with unobserved EBITDA margin: earnings-based channels (valuation, PD) excluded'); ebitdaDrop = null; }
      else ebitdaDrop = Math.min(1, (tCost + natLoss) / v.ebitdaMargin);
    }
    const dmg = sc.physical?.damageRatio?.[s] ?? 0;
    if (dmg > 0) {
      if (unobs(v.physicalAssetShare)) { unobserved.push(`physical_asset_share:${s}`); lb.add('sectors with unobserved physical-asset share are excluded from physical channel'); row.channels.physical = 'UNOBSERVED'; }
      else { phys = dmg * v.physicalAssetShare; row.channels.physical = phys; }
    }
    const ins = unobs(c.insurance?.[s]?.coverage) ? null : c.insurance[s].coverage;
    if (phys > 0 && ins === null) { unobserved.push(`insurance_coverage:${s}`); lb.add('insurance coverage unobserved: physical damage is treated as UNINSURED for the owner and the insurer channel is excluded'); }
    const insured = ins === null ? 0 : ins;
    const physUninsured = phys * (1 - insured);
    let vEb = 0;
    if (ebitdaDrop !== null && ebitdaDrop > 0) { if (unobs(p.valuationPassThrough)) { unobserved.push('climate_param:valuationPassThrough'); lb.add('valuationPassThrough unobserved: earnings-to-valuation channel excluded'); } else vEb = Math.min(1, p.valuationPassThrough * ebitdaDrop); }
    let pdShift = 0;
    if (ebitdaDrop !== null && ebitdaDrop > 0) { if (unobs(p.pdSensitivity)) { unobserved.push('climate_param:pdSensitivity'); lb.add('pdSensitivity unobserved: PD channel excluded'); } else pdShift = p.pdSensitivity * ebitdaDrop; }
    out[s] = { ...row, transitionCostRatio: tCost, natureRevenueLoss: natLoss, ebitdaDrop, physicalDamage: phys, physicalInsured: phys * insured, physicalUninsured: physUninsured, valuationHaircut: 1 - (1 - vEb) * (1 - physUninsured), pdShift };
  }
  return { sectors: out, unobserved, lb };
}

/** Maps sector results onto the shared balance sheets. Returns deltas for propagate()/the twin. */
export function climateTransmission(system, scenario, p, ix = indexSystem(system)) {
  const c = system.climate; const { sectors, unobserved, lb } = climateSectors(system, scenario, p);
  const priceShocks = {}; for (const [a, s] of Object.entries(c.assetSector || {})) if (sectors[s].valuationHaircut > 0) priceShocks[a] = sectors[s].valuationHaircut;
  const dA = new Array(ix.n).fill(0); const effects = []; const pdShifts = [];
  ix.E.forEach((e, i) => {
    if (e.riskSector && !unobs(e.externalAssets)) { const l = e.externalAssets * sectors[e.riskSector].valuationHaircut; dA[i] -= l; if (l > 0) effects.push({ entity: e.id, channel: 'VALUATION_EXTERNAL_ASSETS', loss: l }); }
    for (const b of e.creditBook || []) {
      const s = sectors[b.riskSector]; if (!s || !(s.pdShift > 0)) continue;
      if (unobs(b.pd) || unobs(b.lgd)) { unobserved.push(`climate_credit_inputs:${e.id}:${b.id}`); lb.add('credit book entries with unobserved pd/lgd are excluded'); continue; }
      const pd1 = probitShift(b.pd, s.pdShift); const l = b.amount * b.lgd * (pd1 - b.pd); dA[i] -= l; effects.push({ entity: e.id, channel: 'PD_SHIFT', book: b.id, pd0: b.pd, pd1, loss: l }); pdShifts.push({ entity: e.id, book: b.id, pd0: b.pd, pd1 });
    }
  });
  // insurer channel: insured physical loss = coverage * damaged insured value, shared by insurer according to book shares
  const insuredLossBySector = {};
  for (const [s, v] of Object.entries(sectors)) {
    if (!(v.physicalInsured > 0)) continue;
    const iv = c.insurance?.[s]?.insuredValue;
    if (unobs(iv)) { unobserved.push(`insured_value:${s}`); lb.add('insured value unobserved: insurer losses excluded'); continue; }
    insuredLossBySector[s] = v.physicalInsured * iv;
  }
  for (const [id, m] of Object.entries(c.insurers || {})) {
    const i = ix.eIdx.get(id); let l = 0; for (const [s, sh] of Object.entries(m)) l += sh * (insuredLossBySector[s] || 0);
    if (l > 0) { dA[i] -= l; effects.push({ entity: id, channel: 'INSURED_PHYSICAL_LOSS', loss: l }); }
  }
  return { sectors, priceShocks, extAssetsDelta: dA, effects, pdShifts, insuredLossBySector, unobserved: [...new Set(unobserved)], lowerBoundReasons: [...lb] };
}

export function climateParams(system, options = {}) {
  const q = system.climate.parameters ?? {}; const o = options.params ?? {};
  const g = (k) => (o[k] !== undefined ? o[k] : (q[k] ?? null));
  return { valuationPassThrough: g('valuationPassThrough'), pdSensitivity: g('pdSensitivity') };
}

/** M68 Climate & nature stress: physical, transition and nature-dependency shocks into balance sheets, PD, valuation and systemic risk. */
export function runClimate(system, scenario = {}, options = {}) {
  const err = validateSystemState(system) || validateClimate(system, scenario);
  if (err) return failed(ENGINE, MODEL_ID, err);
  const ix = indexSystem(system); const p = climateParams(system, options);
  const run = (pp) => { const t = climateTransmission(system, scenario, pp, ix); const prop = propagate(system, { priceShocks: t.priceShocks }, { alpha: 1, beta: 1, maxIter: 50000 }, { ix, extAssetsDelta: t.extAssetsDelta }); return { t, prop }; };
  const { t, prop } = run(p);
  const unobserved = [...new Set([...t.unobserved, ...prop.unobserved])];
  let status = STATUS.UNCALIBRATED; const notes = ['Climate/nature transmission is a reduced-form scenario model (caller-supplied sector parameters, pass-through and sensitivities): UNCALIBRATED, not a forecast of climate outcomes or prices.'];
  if (!prop.system.converged) status = STATUS.MODEL_UNCERTAIN; else if (!prop.system.reconciled) status = STATUS.COMPUTATION_FAILED;
  else if (unobserved.length) { status = STATUS.INSUFFICIENT_OBSERVABILITY; notes.push('unobserved inputs exclude channels (never zero): lower bound'); }
  const u = options.uncertainty ?? {};
  const uncertainty = parameterBand({ evaluate: (pp) => run({ ...p, ...pp }).prop.system.systemLoss, params: p, keys: ['valuationPassThrough', 'pdSensitivity'], ranges: u.ranges ?? {}, n: u.n ?? 24, seed: options.seed ?? 1, label: ENGINE });
  const contagion = prop;
  return makeResult({
    engine: ENGINE, modelId: MODEL_ID, status,
    value: { sectors: t.sectors, assetHaircuts: t.priceShocks, effects: t.effects, insuredLossBySector: t.insuredLossBySector, totals: { creditAndValuationLoss: -sumArr(t.extAssetsDelta), systemLoss: prop.system.systemLoss }, contagion, lowerBound: unobserved.length > 0, handoff: { priceShocks: t.priceShocks, extAssetsDelta: t.extAssetsDelta, pdShifts: t.pdShifts } },
    uncertainty, coverage: coverageOf(Object.keys(system.climate.sectors).length - new Set(unobserved.filter((x) => /:/.test(x)).map((x) => x.split(':')[1])).size, Object.keys(system.climate.sectors).length), unobserved, calibration: CALIBRATION.UNCALIBRATED,
    parameters: { ...p, scenario: scenario.climate, ebitdaDrop: '(transition cost + nature revenue loss)/ebitdaMargin, capped at 1 (ASSUMED)', valuation: 'haircut = passThrough x EBITDA drop (constant multiple, ASSUMED)' },
    inputHashes: [hashOf(system.climate)], notes,
  });
}
