import { makeResult, failed, STATUS, CALIBRATION, coverageOf } from '../../core/result.js';
import { hashOf } from '../../core/canonical.js';
import { parameterBand } from '../../core/sensitivity.js';
import { isNum, isNonNeg, isFrac, unobs } from '../../core/numeric.js';
import { priceImpact } from '../impact.js';
import { hhi } from '../concentration.js';
import { validateSystemState, indexSystem, sumArr } from './state.js';

const ENGINE = 'ccp';
export const MODEL_ID = 'M64.ccp_default_waterfall';

export function validateCcp(system, scenario) {
  const list = system.ccps;
  if (!Array.isArray(list) || !list.length) return 'system.ccps (non-empty array) required';
  const eIds = new Map(system.entities.map((e) => [e.id, e])); const aIds = new Set((system.assets ?? []).map((a) => a.id));
  for (const c of list) {
    if (!eIds.has(c.id) || eIds.get(c.id).sector !== 'CCP') return `ccp ${c.id}: must be an entity with sector CCP`;
    if (!isNonNeg(c.skinInTheGame)) return `ccp ${c.id}: skinInTheGame must be >= 0 (explicit)`;
    if (!unobs(c.assessmentCap) && !isNonNeg(c.assessmentCap)) return `ccp ${c.id}: assessmentCap must be null or >= 0`;
    if (!(c.members?.length >= 2)) return `ccp ${c.id}: at least two members required`;
    const seen = new Set();
    for (const m of c.members) {
      if (!eIds.has(m.entity) || seen.has(m.entity)) return `ccp ${c.id}: unknown/duplicate member ${m.entity}`; seen.add(m.entity);
      if (!isNonNeg(m.im) || !isNonNeg(m.dfContribution)) return `ccp ${c.id}: member ${m.entity} im/dfContribution must be >= 0`;
      if (!unobs(m.capital) && !isNonNeg(m.capital)) return `ccp ${c.id}: member ${m.entity} capital must be null or >= 0`;
      for (const p of m.positions || []) if (!aIds.has(p.asset) || !isNum(p.exposure)) return `ccp ${c.id}: member ${m.entity} invalid position`;
    }
  }
  const sc = scenario.ccp ?? {};
  for (const [k, s] of Object.entries(sc.priceShocks || {})) if (!aIds.has(k) || !isFrac(s)) return `ccp price shock ${k} invalid`;
  for (const d of sc.defaulters || []) if (!eIds.has(d)) return `ccp defaulter ${d}: unknown entity`;
  return null;
}

/** One CCP: pooled default waterfall with survivor-default propagation. */
export function ccpWaterfall(system, ccp, defaultersInit, shocks, ix = indexSystem(system)) {
  const unobserved = []; const lb = new Set();
  const members = ccp.members; const price = ix.price;
  const lossOf = new Map(); const detail = new Map();
  for (const m of members) {
    let move = 0; let cost = 0;
    for (const p of m.positions || []) {
      const k = ix.aIdx.get(p.asset); const s = shocks[p.asset] ?? 0;
      move += p.exposure * s; // long loses when price falls
      const d = priceImpact(system.impact ?? { model: 'amihud-linear' }, ix.A[k], Math.abs(p.exposure));
      if (d === null) { unobserved.push(`ccp_closeout_impact:${m.entity}:${p.asset}`); lb.add('close-out liquidity cost unobserved for some positions (excluded, not zero): losses are lower bounds'); } else cost += Math.abs(p.exposure) * d;
    }
    void price;
    lossOf.set(m.entity, Math.max(0, move + cost)); detail.set(m.entity, { priceMoveLoss: move, closeoutCost: cost });
  }
  const D = new Set(defaultersInit); const rounds = []; let charges = new Map(members.map((m) => [m.entity, 0]));
  let layers = null;
  for (let r = 0; r <= members.length; r++) {
    const defs = members.filter((m) => D.has(m.entity)); const surv = members.filter((m) => !D.has(m.entity));
    const L = sumArr(defs.map((m) => lossOf.get(m.entity)));
    const imD = sumArr(defs.map((m) => m.im)); const dfD = sumArr(defs.map((m) => m.dfContribution));
    const imUsed = Math.min(L, imD); const u1 = L - imUsed;
    const dfDUsed = Math.min(u1, dfD); const u2 = u1 - dfDUsed;
    const sitgUsed = Math.min(u2, ccp.skinInTheGame); const u3 = u2 - sitgUsed;
    const pool = sumArr(surv.map((m) => m.dfContribution)); const dfSUsed = Math.min(u3, pool); const u4 = u3 - dfSUsed;
    let assessUsed = 0; let capTot = 0;
    if (unobs(ccp.assessmentCap)) { if (u4 > 0) { unobserved.push(`ccp_assessment_cap:${ccp.id}`); lb.add('assessment cap unobserved: no assessment powers assumed; unfunded loss may be overstated, charges understated'); } }
    else { capTot = sumArr(surv.map((m) => ccp.assessmentCap * m.dfContribution)); assessUsed = Math.min(u4, capTot); }
    const unfunded = u4 - assessUsed;
    charges = new Map(members.map((m) => [m.entity, 0]));
    for (const m of surv) {
      const dfShare = pool > 0 ? dfSUsed * (m.dfContribution / pool) : 0;
      const asShare = capTot > 0 ? assessUsed * (ccp.assessmentCap * m.dfContribution / capTot) : 0;
      charges.set(m.entity, dfShare + asShare);
    }
    layers = { totalLoss: L, defaulterIM: imUsed, defaulterDF: dfDUsed, skinInTheGame: sitgUsed, survivorDF: dfSUsed, assessments: assessUsed, unfunded };
    const newDef = [];
    for (const m of surv) {
      if (unobs(m.capital)) { unobserved.push(`ccp_member_capital:${m.entity}`); lb.add('member capital unobserved: survivor default not assessable (excluded)'); continue; }
      if (charges.get(m.entity) > m.capital + 1e-12) newDef.push(m.entity);
    }
    rounds.push({ round: r, defaulters: [...D], layers, newDefaults: newDef });
    if (!newDef.length) break;
    newDef.forEach((e) => D.add(e));
  }
  // concentration and cover-N
  const imShares = members.map((m) => ({ id: m.entity, w: sumArr(members.map((x) => x.im)) > 0 ? m.im / sumArr(members.map((x) => x.im)) : 0 }));
  const conc = hhi(imShares, { entity: ccp.id });
  const uncovered = members.map((m) => ({ id: m.entity, v: Math.max(0, lossOf.get(m.entity) - m.im) })).sort((a, b) => b.v - a.v || a.id.localeCompare(b.id));
  const cover2Need = sumArr(uncovered.slice(0, 2).map((x) => x.v));
  const resources = sumArr(members.map((m) => m.dfContribution)) + ccp.skinInTheGame;
  return {
    ccp: ccp.id, defaulters: [...D], initialDefaulters: [...defaultersInit], propagatedDefaults: [...D].filter((x) => !defaultersInit.includes(x)), rounds, finalLayers: layers,
    memberCharges: Object.fromEntries([...charges.entries()].filter(([, v]) => v > 0)), memberLoss: Object.fromEntries([...lossOf.entries()].map(([k, v]) => [k, { loss: v, ...detail.get(k) }])),
    concentration: { memberIm: conc.value, top2UncoveredLoss: cover2Need, resourcesDfPlusSitg: resources, cover2Ratio: cover2Need > 0 ? resources / cover2Need : null, cover2Satisfied: cover2Need <= resources + 1e-12 },
    unobserved, lowerBoundReasons: [...lb],
  };
}

export function runCcp(system, scenario = {}, options = {}, ctx = {}) {
  const err = validateSystemState(system) || validateCcp(system, scenario);
  if (err) return failed(ENGINE, MODEL_ID, err);
  const ix = indexSystem(system); const sc = scenario.ccp ?? {};
  const shocksBase = sc.priceShocks || {};
  const scale = options.lossScale ?? 1;
  const evalAll = (sc2) => system.ccps.map((c) => {
    const memberIds = new Set(c.members.map((m) => m.entity));
    const defs = [...new Set([...(sc.defaulters || []), ...(ctx.defaultedEntities || [])])].filter((d) => memberIds.has(d));
    return ccpWaterfall(system, c, defs, Object.fromEntries(Object.entries(shocksBase).map(([k, v]) => [k, Math.min(1, v * sc2)])), ix);
  });
  const res = evalAll(scale);
  const unobserved = [...new Set(res.flatMap((x) => x.unobserved))];
  let status = STATUS.UNCALIBRATED; const notes = ['CCP waterfall under stated rules (IM -> defaulter DF -> skin-in-the-game -> survivor DF -> assessments); close-out cost = |position| x model price impact (conservative); UNCALIBRATED.'];
  if (unobserved.length) { status = STATUS.INSUFFICIENT_OBSERVABILITY; notes.push('unobserved inputs excluded: lower bound'); }
  const u = options.uncertainty ?? {};
  const uncertainty = parameterBand({ evaluate: (pp) => sumArr(evalAll(pp.lossScale).map((x) => x.finalLayers.survivorDF + x.finalLayers.assessments + x.finalLayers.unfunded)), params: { lossScale: scale }, keys: ['lossScale'], ranges: u.ranges ?? { lossScale: [0.5, 1.5] }, n: u.n ?? 24, seed: options.seed ?? 1, label: ENGINE });
  return makeResult({
    engine: ENGINE, modelId: MODEL_ID, status,
    value: { ccps: res, handoff: { memberCharges: Object.fromEntries(res.flatMap((x) => Object.entries(x.memberCharges))), defaultedMembers: res.flatMap((x) => x.defaulters), unfundedLoss: sumArr(res.map((x) => x.finalLayers.unfunded)) }, lowerBound: unobserved.length > 0 },
    uncertainty, coverage: coverageOf(system.ccps.length, system.ccps.length), unobserved, calibration: CALIBRATION.UNCALIBRATED,
    parameters: { lossScale: scale, shocks: shocksBase, defaulters: sc.defaulters || [], defaultedFromCollateral: ctx.defaultedEntities || [], waterfall: ['defaulterIM', 'defaulterDF', 'skinInTheGame', 'survivorDF', 'assessments', 'unfunded'], closeoutCost: '|exposure| x price impact(|exposure|)' },
    inputHashes: [hashOf(system.ccps)], notes,
  });
}
