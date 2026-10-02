import { makeResult, failed, STATUS, CALIBRATION, coverageOf } from '../../core/result.js';
import { hashOf } from '../../core/canonical.js';
import { parameterBand } from '../../core/sensitivity.js';
import { isNum, isNonNeg, isFrac, unobs, cmp } from '../../core/numeric.js';
import { hhi } from '../concentration.js';
import { validateSystemState, sumArr } from './state.js';

const ENGINE = 'opContagion';
export const MODEL_ID = 'M67.operational_contagion';
export const NODE_KINDS = Object.freeze(['CLOUD', 'DATA', 'TRADING', 'SETTLEMENT', 'PAYMENT', 'SERVICE_PROVIDER', 'INSTITUTION']);
export const FLOW_KINDS = Object.freeze(['PAYMENT', 'SETTLEMENT', 'MARGIN']);
/** The engine models the CONSEQUENCES of a given outage scenario. It never estimates how likely an attack or failure is. */
export const FORBIDDEN_KEY = /probab|likelihood|hack|attack|exploit_?score|breach_?score|threat_?score/i;
const MAX_ITER = 200;

function scanForbidden(obj, path = '') {
  if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) { if (FORBIDDEN_KEY.test(k)) return `${path}${k}`; const r = scanForbidden(v, `${path}${k}.`); if (r) return r; }
  return null;
}

export function validateOp(system, scenario) {
  const o = system.opDeps;
  if (!o || typeof o !== 'object') return 'system.opDeps required';
  const bad = scanForbidden(o, 'opDeps.') || scanForbidden(scenario.opDeps ?? {}, 'scenario.opDeps.');
  if (bad) return `field "${bad}" rejected: M67 models consequences of an outage scenario and never produces or accepts attack/failure probabilities`;
  if (!(o.nodes?.length)) return 'opDeps.nodes required';
  const ids = new Set(); const eIds = new Set(system.entities.map((e) => e.id));
  for (const n of o.nodes) {
    if (!n.id || ids.has(n.id)) return 'node id missing/duplicate'; ids.add(n.id);
    if (!NODE_KINDS.includes(n.kind)) return `node ${n.id}: kind must be ${NODE_KINDS.join('|')}`;
    if (n.entity !== undefined && !eIds.has(n.entity)) return `node ${n.id}: unknown entity ${n.entity}`;
  }
  const H = o.horizonHours ?? 24; if (!(isNum(H) && H > 0 && H <= 720)) return 'opDeps.horizonHours must be in (0, 720]';
  for (const d of o.dependencies || []) {
    if (!ids.has(d.consumer) || !ids.has(d.provider) || d.consumer === d.provider) return `dependency ${d.consumer}->${d.provider} invalid`;
    if (!isFrac(d.criticality)) return `dependency ${d.consumer}->${d.provider}: criticality must be in [0,1]`;
    if (d.alternate !== undefined && d.alternate !== null && (!ids.has(d.alternate) || d.alternate === d.provider)) return `dependency ${d.consumer}->${d.provider}: invalid alternate`;
    if (!unobs(d.rerouteShare) && !isFrac(d.rerouteShare)) return 'rerouteShare must be null or in [0,1]';
    if (!unobs(d.failoverHours) && !isNonNeg(d.failoverHours)) return 'failoverHours must be null or >= 0';
  }
  for (const f of o.flows || []) {
    if (!eIds.has(f.payer) || !eIds.has(f.payee) || f.payer === f.payee || !ids.has(f.via)) return 'flow: unknown payer/payee/via';
    if (!isNonNeg(f.valuePerDay)) return 'flow.valuePerDay must be >= 0';
    if (f.kind !== undefined && !FLOW_KINDS.includes(f.kind)) return `flow.kind must be ${FLOW_KINDS.join('|')}`;
  }
  for (const out of scenario.opDeps?.outages || []) {
    if (!ids.has(out.node)) return `outage: unknown node ${out.node}`;
    if (!(isNum(out.durationHours) && out.durationHours > 0 && out.durationHours <= 720)) return 'outage.durationHours must be in (0, 720]';
  }
  return null;
}

/** Availability propagation (monotone fixed point; cycles allowed). u[n] = unavailable fraction of the horizon. */
export function propagateOutage(o, outages, p) {
  const H = o.horizonHours ?? 24; const idx = new Map(o.nodes.map((n, i) => [n.id, i])); const N = o.nodes.length;
  const uDirect = new Array(N).fill(0);
  for (const out of outages) uDirect[idx.get(out.node)] = Math.max(uDirect[idx.get(out.node)], Math.min(1, (out.durationHours * p.durationScale) / H));
  const deps = o.nodes.map(() => []); const unobserved = [];
  for (const d of o.dependencies || []) {
    const r = unobs(d.rerouteShare) || unobs(d.failoverHours) || !d.alternate ? 0 : Math.min(1, d.rerouteShare * p.rerouteScale);
    if (d.alternate && (unobs(d.rerouteShare) || unobs(d.failoverHours))) unobserved.push(`substitution:${d.consumer}->${d.provider}`);
    deps[idx.get(d.consumer)].push({ p: idx.get(d.provider), alt: d.alternate ? idx.get(d.alternate) : null, crit: d.criticality, r, f: unobs(d.failoverHours) ? 0 : d.failoverHours });
  }
  let u = uDirect.slice(); let converged = false; let it = 0;
  for (; it < MAX_ITER; it++) {
    const next = new Array(N);
    for (let n = 0; n < N; n++) {
      let keep = 1;
      for (const d of deps[n]) {
        const up = u[d.p];
        let ueff = 0;
        if (up > 0) { const ua = d.alt === null ? 0 : u[d.alt]; ueff = (1 - d.r) * up + d.r * Math.min(up, Math.max(d.f / H, ua)); }
        keep *= 1 - d.crit * ueff;
      }
      next[n] = 1 - (1 - uDirect[n]) * keep;
    }
    let diff = 0; for (let n = 0; n < N; n++) diff = Math.max(diff, Math.abs(next[n] - u[n]));
    u = next; if (diff < 1e-14) { converged = true; break; }
  }
  return { u, converged, iterations: it + 1, unobserved, idx };
}

/** Consequence chain: outage -> settlement/payment disruption -> liquidity & margin shortfall. */
export function opChain(system, scenario, p) {
  const o = system.opDeps; const H = o.horizonHours ?? 24;
  const prop = propagateOutage(o, scenario.opDeps?.outages ?? [], p);
  const { u, idx } = prop; const E = system.entities; const eIdx = new Map(E.map((e, i) => [e.id, i]));
  const instNode = new Map(o.nodes.filter((n) => n.entity).map((n) => [n.entity, n.id]));
  const flows = (o.flows || []).map((f) => {
    const uVia = u[idx.get(f.via)]; const uPayer = instNode.has(f.payer) ? u[idx.get(instNode.get(f.payer))] : 0;
    const fail = 1 - (1 - uVia) * (1 - uPayer); const scheduled = f.valuePerDay * (H / 24);
    return { payer: f.payer, payee: f.payee, via: f.via, kind: f.kind ?? 'PAYMENT', scheduled, failedFraction: fail, failed: scheduled * fail };
  });
  const n = E.length; const inBase = new Array(n).fill(0); const inStress = new Array(n).fill(0); const outBase = new Array(n).fill(0); const outStress = new Array(n).fill(0);
  for (const f of flows) { const a = eIdx.get(f.payer); const b = eIdx.get(f.payee); outBase[a] += f.scheduled; outStress[a] += f.scheduled - f.failed; inBase[b] += f.scheduled; inStress[b] += f.scheduled - f.failed; }
  const entities = E.map((e, i) => {
    const gapBase = Math.max(0, outBase[i] - (inBase[i] + e.cash)); const gapStress = Math.max(0, outStress[i] - (inStress[i] + e.cash));
    return { entity: e.id, inflowLost: inBase[i] - inStress[i], paymentsNotSent: outBase[i] - outStress[i], liquidityGapBase: gapBase, liquidityGapStress: gapStress, incrementalLiquidityGap: gapStress - gapBase };
  }).filter((x) => x.inflowLost > 0 || x.paymentsNotSent > 0 || x.incrementalLiquidityGap > 0);
  const marginFailures = flows.filter((f) => f.kind === 'MARGIN' && f.failed > 0).map((f) => ({ payer: f.payer, payee: f.payee, unpaidMargin: f.failed }));
  return { prop, flows, entities, marginFailures, failedTotal: sumArr(flows.map((f) => f.failed)), scheduledTotal: sumArr(flows.map((f) => f.scheduled)), nodeUnavailability: Object.fromEntries(o.nodes.map((nd, i) => [nd.id, u[i]]).filter((x) => x[1] > 0)) };
}

/** Structural dependency analysis + single-node full-outage sweep (no probabilities). */
export function dependencyAnalysis(system, p, topK = 5) {
  const o = system.opDeps; const H = o.horizonHours ?? 24;
  const providers = [...new Set((o.dependencies || []).map((d) => d.provider))];
  const dependents = (id) => (o.dependencies || []).filter((d) => d.provider === id);
  const totalCrit = sumArr((o.dependencies || []).map((d) => d.criticality));
  const concentration = hhi(providers.map((id) => ({ id, w: totalCrit > 0 ? sumArr(dependents(id).map((d) => d.criticality)) / totalCrit : 0 })), { entity: 'providers' }).value;
  const sweep = o.nodes.map((nd) => {
    const c = opChain(system, { opDeps: { outages: [{ node: nd.id, durationHours: H }] } }, { ...p, durationScale: 1 });
    return { node: nd.id, kind: nd.kind, failedFlowValue: c.failedTotal, failedShare: c.scheduledTotal > 0 ? c.failedTotal / c.scheduledTotal : null, institutionsAffected: c.entities.length };
  }).sort((a, b) => b.failedFlowValue - a.failedFlowValue || cmp(a.node, b.node));
  return { providerConcentration: concentration, singleNodeFullOutageSweep: sweep.slice(0, topK), singlePointsOfFailure: sweep.filter((x) => x.failedShare !== null && x.failedShare >= (p.spofThreshold ?? 0.1)).map((x) => x.node) };
}

export function runOpContagion(system, scenario = {}, options = {}) {
  const err = validateSystemState(system) || validateOp(system, scenario);
  if (err) return failed(ENGINE, MODEL_ID, err);
  const p = { durationScale: 1, rerouteScale: 1, spofThreshold: options.spofThreshold ?? 0.1 };
  const chain = opChain(system, scenario, p);
  const structure = dependencyAnalysis(system, p, options.topK ?? 5);
  const unobserved = [...new Set(chain.prop.unobserved)];
  let status = STATUS.UNCALIBRATED; const notes = ['Consequence model for a GIVEN outage scenario; no probability of any attack, hack or failure is estimated or accepted. Dependency data are caller-supplied and UNCALIBRATED.'];
  if (!chain.prop.converged) status = STATUS.MODEL_UNCERTAIN;
  else if (unobserved.length) { status = STATUS.INSUFFICIENT_OBSERVABILITY; notes.push('unobserved substitution terms are treated as NO substitution (stress upper side), not as perfect resilience'); }
  const u = options.uncertainty ?? {};
  const uncertainty = parameterBand({ evaluate: (pp) => opChain(system, scenario, { ...p, ...pp }).failedTotal, params: p, keys: ['durationScale', 'rerouteScale'], ranges: u.ranges ?? { durationScale: [0.5, 1.5], rerouteScale: [0.5, 1] }, n: u.n ?? 24, seed: options.seed ?? 1, label: ENGINE });
  return makeResult({
    engine: ENGINE, modelId: MODEL_ID, status,
    value: { nodeUnavailability: chain.nodeUnavailability, flows: chain.flows, entities: chain.entities, marginDeliveryFailures: chain.marginFailures, totals: { scheduled: chain.scheduledTotal, failed: chain.failedTotal, failedShare: chain.scheduledTotal > 0 ? chain.failedTotal / chain.scheduledTotal : null }, structure, upperBoundReasons: unobserved.length ? ['unobserved substitution parameters treated as no substitution'] : [], horizonHours: system.opDeps.horizonHours ?? 24,
      handoff: { liquidityInflowLost: Object.fromEntries(chain.entities.filter((x) => x.inflowLost > 0).map((x) => [x.entity, x.inflowLost])), incrementalLiquidityGap: Object.fromEntries(chain.entities.filter((x) => x.incrementalLiquidityGap > 0).map((x) => [x.entity, x.incrementalLiquidityGap])), marginDeliveryFailures: chain.marginFailures } },
    uncertainty, coverage: coverageOf(system.opDeps.nodes.length - unobserved.length, system.opDeps.nodes.length), unobserved, calibration: CALIBRATION.UNCALIBRATED,
    parameters: { horizonHours: system.opDeps.horizonHours ?? 24, outages: scenario.opDeps?.outages ?? [], combination: 'independent multiplicative availability of dependencies (ASSUMED)', spofThreshold: p.spofThreshold, noProbabilities: true },
    inputHashes: [hashOf(system.opDeps)], notes,
  });
}
