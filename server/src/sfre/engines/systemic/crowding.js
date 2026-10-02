import { makeResult, failed, STATUS, CALIBRATION, coverageOf } from '../../core/result.js';
import { hashOf } from '../../core/canonical.js';
import { parameterBand } from '../../core/sensitivity.js';
import { isNum, isNonNeg, isFrac, unobs } from '../../core/numeric.js';
import { priceImpact } from '../impact.js';
import { hhi } from '../concentration.js';
import { pairOverlap } from '../overlap.js';
import { validateSystemState, indexSystem, sumArr } from './state.js';

const ENGINE = 'aiCrowding';
export const MODEL_ID = 'M66.ai_crowding';
export const MAX_ROUNDS = 30;

export function validateCrowding(system, scenario) {
  const c = system.crowding;
  if (!c || typeof c !== 'object') return 'system.crowding required';
  if (!(c.agents?.length >= 2)) return 'crowding.agents (>= 2) required';
  const signals = new Set(c.signals || []);
  if (!signals.size) return 'crowding.signals required';
  const aIds = new Set((system.assets ?? []).map((a) => a.id)); const seen = new Set();
  for (const a of c.agents) {
    if (!a.id || seen.has(a.id)) return 'crowding agent id missing/duplicate'; seen.add(a.id);
    if (!(isNum(a.capital) && a.capital > 0) || !isNonNeg(a.leverage)) return `agent ${a.id}: capital must be > 0 and leverage >= 0`;
    if (!a.modelId) return `agent ${a.id}: modelId required (shared-model concentration)`;
    const l = Object.entries(a.loadings || {}); if (!l.length) return `agent ${a.id}: loadings required`;
    for (const [s, w] of l) if (!signals.has(s) || !isNum(w)) return `agent ${a.id}: invalid loading ${s}`;
    if (!Object.values(a.loadings).some((w) => w !== 0)) return `agent ${a.id}: all-zero loadings`;
    const w = Object.entries(a.assetWeights || {}); if (!w.length) return `agent ${a.id}: assetWeights required`;
    for (const [k, v] of w) if (!aIds.has(k) || !isNum(v)) return `agent ${a.id}: invalid assetWeight ${k}`;
    if (Math.abs(sumArr(w.map(([, v]) => Math.abs(v))) - 1) > 1e-9) return `agent ${a.id}: sum |assetWeights| must be 1`;
    if (!unobs(a.stopLoss) && !(isNum(a.stopLoss) && a.stopLoss > 0 && a.stopLoss <= 1)) return `agent ${a.id}: stopLoss must be null or in (0,1]`;
    if (!unobs(a.deleverageFraction) && !isFrac(a.deleverageFraction)) return `agent ${a.id}: deleverageFraction must be null or in [0,1]`;
    if (a.entity && !system.entities.some((e) => e.id === a.entity)) return `agent ${a.id}: unknown entity ${a.entity}`;
  }
  const sc = scenario.crowding ?? {};
  if (!(isNum(sc.responseScale) && sc.responseScale > 0)) return 'scenario.crowding.responseScale must be > 0 (explicit)';
  if (!Object.keys(sc.signalShocks || {}).length) return 'scenario.crowding.signalShocks required';
  for (const [s, v] of Object.entries(sc.signalShocks)) if (!signals.has(s) || !isNum(v)) return `signalShock ${s} invalid`;
  return null;
}

/** Normalised loading matrix rows (unit L2 norm). */
const unitRows = (agents, signals) => agents.map((a) => { const v = signals.map((s) => a.loadings[s] ?? 0); const nr = Math.sqrt(sumArr(v.map((x) => x * x))); return v.map((x) => x / nr); });

/**
 * Effective number of independent strategies N_eff = (tr G)^2 / ||G||_F^2, G = X X' with unit-norm loading rows
 * (participation ratio of the eigenvalues of G): identical agents -> 1, orthogonal agents -> n.
 */
export function effectiveIndependent(X) {
  const n = X.length; let fro = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { let d = 0; for (let k = 0; k < X[i].length; k++) d += X[i][k] * X[j][k]; fro += d * d; }
  return (n * n) / fro;
}

/** Structural setup shared by the standalone cascade and the Digital Twin: loadings, positions, round-0 orders and measures. */
export function crowdingSetup(system, scenario, p, ix = indexSystem(system)) {
  const c = system.crowding; const A = ix.A; const sc = scenario.crowding;
  const agents = c.agents; const nA = A.length;
  const X = unitRows(agents, c.signals);
  const G = agents.map((a) => a.capital * a.leverage); // gross exposure
  const wAsset = agents.map((a) => { const r = new Array(nA).fill(0); for (const [k, v] of Object.entries(a.assetWeights)) r[ix.aIdx.get(k)] = v; return r; });
  const pos = agents.map((a, i) => wAsset[i].map((w) => G[i] * w)); // current signed exposure (value)
  const z = agents.map((a) => sumArr(c.signals.map((s) => (a.loadings[s] ?? 0) * (sc.signalShocks[s] ?? 0))));
  const order0 = agents.map((a, i) => wAsset[i].map((w) => G[i] * p.responseScale * z[i] * w));
  const n = agents.length;
  let simSum = 0; let simN = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { simSum += sumArr(X[i].map((x, k) => x * X[j][k])); simN++; }
  const absW = (i) => Object.fromEntries(Object.entries(agents[i].assetWeights).map(([k, v]) => [k, Math.abs(v)]));
  let ovSum = 0; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) ovSum += pairOverlap(absW(i), absW(j)).overlap;
  const capTot = sumArr(agents.map((a) => a.capital));
  const share = (key) => { const m = {}; agents.forEach((a) => { for (const v of key(a)) m[v] = (m[v] || 0) + a.capital / capTot / key(a).length; }); return Object.entries(m).map(([id, w]) => ({ id, w })); };
  const measures = {
    meanSignalSimilarity: simN ? simSum / simN : null, effectiveIndependentStrategies: effectiveIndependent(X), agents: n,
    modelConcentration: hhi(share((a) => [a.modelId])).value, dataVendorConcentration: hhi(share((a) => (a.dataVendors?.length ? a.dataVendors : ['UNSPECIFIED']))).value,
    meanPositionOverlap: simN ? ovSum / simN : null,
  };
  return { agents, X, G, wAsset, pos, order0, measures, triggered: agents.map(() => false), pnlCum: agents.map(() => 0), p };
}

/**
 * Stop-loss feedback from a price move: updates cumulative P&L of every agent (exposure x relative price change this step),
 * triggers agents breaching their stop-loss and returns their deleveraging orders (signed value, per agent x asset).
 */
export function crowdingFeedback(st, relMoves, unobserved = [], lb = new Set(), first = false) {
  const nA = st.wAsset[0].length; const next = st.agents.map(() => new Array(nA).fill(0)); let newTrig = 0;
  st.agents.forEach((a, i) => {
    st.pnlCum[i] += sumArr(st.pos[i].map((v, k) => v * relMoves[k]));
    if (unobs(a.stopLoss)) { if (first) { unobserved.push(`stop_loss:${a.id}`); lb.add('agents with unobserved stop-loss never deleverage in this model (cascade is a lower bound)'); } return; }
    if (!st.triggered[i] && -st.pnlCum[i] / a.capital >= a.stopLoss) {
      st.triggered[i] = true; newTrig++;
      const frac = a.deleverageFraction ?? st.p.deleverageFraction;
      for (let k = 0; k < nA; k++) next[i][k] = -frac * st.pos[i][k];
    }
  });
  return { orders: next, newTrig };
}

export function crowdingCascade(system, scenario, p, ix = indexSystem(system)) {
  const A = ix.A; const nA = A.length;
  const unobserved = []; const lb = new Set();
  const st = crowdingSetup(system, scenario, p, ix);
  const { agents, order0, measures, triggered, pnlCum } = st;
  // ---- simultaneous orders -> liquidity consumption -> impact -> cascade
  const price = A.map((a) => a.price); const cumD = new Array(nA).fill(0); const rounds = []; const dep = unobs;
  let orders = order0; let converged = false;
  let round0 = null;
  for (let r = 0; r < MAX_ROUNDS; r++) {
    const net = new Array(nA).fill(0); const gross = new Array(nA).fill(0); const sq = new Array(nA).fill(0);
    orders.forEach((row) => row.forEach((q, k) => { net[k] += q; gross[k] += Math.abs(q); sq[k] += q * q; }));
    const dRound = new Array(nA).fill(0); const tbl = [];
    for (let k = 0; k < nA; k++) {
      if (!(gross[k] > 0)) continue;
      const imp = priceImpact(system.impact, A[k], Math.abs(net[k]));
      const impInd = priceImpact(system.impact, A[k], Math.sqrt(sq[k]));
      if (imp === null) { if (!unobserved.includes(`impact_inputs:${A[k].id}`)) unobserved.push(`impact_inputs:${A[k].id}`); lb.add('price impact unobserved for traded assets: impact excluded (not zero); lower bound'); continue; }
      dRound[k] = Math.sign(net[k]) * imp; cumD[k] += dRound[k];
      tbl.push({ asset: A[k].id, netFlow: net[k], grossFlow: gross[k], liquidityConsumption: dep(A[k].advValue) ? null : gross[k] / A[k].advValue, impact: dRound[k], independentImpact: Math.sign(net[k]) * (impInd ?? 0), herdingRatio: sq[k] > 0 ? Math.abs(net[k]) / Math.sqrt(sq[k]) : null });
      price[k] *= 1 + dRound[k];
    }
    if (r === 0) round0 = { table: tbl, cumD: cumD.slice() };
    // P&L on existing exposure from this round's price move; stop-loss triggers
    const { orders: next, newTrig } = crowdingFeedback(st, dRound, unobserved, lb, r === 0);
    rounds.push({ round: r, netFlows: Object.fromEntries(A.map((a, k) => [a.id, net[k]]).filter((x) => x[1] !== 0)), priceMoves: Object.fromEntries(A.map((a, k) => [a.id, dRound[k]]).filter((x) => x[1] !== 0)), newlyTriggered: agents.filter((_, i) => next[i].some((v) => v !== 0)).map((a) => a.id) });
    if (!newTrig) { converged = true; break; }
    orders = next;
  }
  const mag0 = sumArr(round0.cumD.map(Math.abs)); const magT = sumArr(cumD.map(Math.abs));
  return {
    converged, measures, rounds, round0: round0.table, priceMoves: Object.fromEntries(A.map((a, k) => [a.id, cumD[k]]).filter((x) => x[1] !== 0)),
    cascadeMultiplier: mag0 > 0 ? magT / mag0 : null, triggeredAgents: agents.filter((_, i) => triggered[i]).map((a) => a.id),
    agentLoss: agents.map((a, i) => ({ id: a.id, entity: a.entity ?? null, pnl: pnlCum[i], drawdown: -pnlCum[i] / a.capital })),
    handoff: { priceMoves: Object.fromEntries(A.map((a, k) => [a.id, cumD[k]]).filter((x) => x[1] !== 0)), agentLoss: Object.fromEntries(agents.filter((a) => a.entity).map((a) => [a.entity, Math.max(0, -pnlCum[agents.indexOf(a)])])) },
    unobserved: [...new Set(unobserved)], lowerBoundReasons: [...lb],
  };
}

export function runAiCrowding(system, scenario = {}, options = {}) {
  const err = validateSystemState(system, { requireImpact: true }) || validateCrowding(system, scenario);
  if (err) return failed(ENGINE, MODEL_ID, err);
  const ix = indexSystem(system); const sc = scenario.crowding;
  const p = { responseScale: sc.responseScale, deleverageFraction: options.deleverageFraction ?? 0.5 };
  const out = crowdingCascade(system, scenario, p, ix);
  let status = STATUS.UNCALIBRATED; const notes = ['Structural crowding measures are measurements; the order/impact cascade is a scenario model with caller-supplied response scale and impact coefficients: UNCALIBRATED. Not evidence that any real participants behave this way.'];
  if (!out.converged) { status = STATUS.MODEL_UNCERTAIN; notes.push('deleveraging cascade did not converge'); } else if (out.unobserved.length) { status = STATUS.INSUFFICIENT_OBSERVABILITY; notes.push('unobserved inputs excluded: lower bound'); }
  const u = options.uncertainty ?? {};
  const uncertainty = parameterBand({ evaluate: (pp) => { const o = crowdingCascade(system, scenario, { ...p, ...pp }, ix); return sumArr(Object.values(o.priceMoves).map(Math.abs)); }, params: p, keys: ['responseScale', 'deleverageFraction'], ranges: u.ranges ?? {}, n: u.n ?? 24, seed: options.seed ?? 1, label: ENGINE });
  return makeResult({
    engine: ENGINE, modelId: MODEL_ID, status, value: { ...out, lowerBound: out.unobserved.length > 0 }, uncertainty,
    coverage: coverageOf(system.crowding.agents.length, system.crowding.agents.length), unobserved: out.unobserved, calibration: CALIBRATION.UNCALIBRATED,
    parameters: { ...p, signalShocks: sc.signalShocks, nEffDefinition: '(tr G)^2/||G||_F^2, G = X X\' with unit-norm loading rows', baseline: 'independent flows: sqrt(sum Q^2)' },
    inputHashes: [hashOf(system)], notes,
  });
}
