import { makeResult, STATUS, failed, coverageOf } from './core/result.js';
import { hashOf } from './core/canonical.js';
import { Rng } from './core/prng.js';
import { createSnapshot, PitStore } from './data/pitStore.js';
import { makeObservation } from './data/observation.js';
import { runCascade, validateSystem } from './engines/cascade.js';
import { counterfactuals } from './engines/counterfactual.js';
import { reverseStress } from './engines/reverseStress.js';
import { tailRisk } from './engines/tailRisk.js';
import { hhi } from './engines/concentration.js';
import { overlapMatrix } from './engines/overlap.js';
import { analyzeNetwork } from './engines/network.js';
import { detectAnomalies } from './engines/anomaly/ensemble.js';
import { fundamentalMetrics } from './engines/fundamentals.js';
import { accountingQuality } from './engines/accountingQuality.js';
import { valuationDivergence } from './engines/valuation.js';
import { fundamentalPriceDivergence } from './engines/divergence.js';
import { pumpDumpPattern } from './engines/integrity.js';
import { attentionAnomaly } from './engines/attention.js';
import { detectCoordination } from './engines/coordination.js';
import { disclosureEvents } from './engines/disclosure.js';
import { createRunRecord } from './governance/runRegistry.js';

export const ENGINE_NAMES = Object.freeze(['cascade', 'counterfactual', 'reverseStress', 'tailRisk', 'concentration', 'overlap', 'anomaly', 'fundamentals', 'accountingQuality', 'valuation', 'divergence', 'integrity', 'attention', 'coordination', 'disclosure']);
export const MAX_OBSERVATIONS = 200000;
// Hard request budgets: engines run synchronously on the API thread, so every dimension that drives CPU is capped.
export const LIMITS = Object.freeze({ funds: 1000, assets: 2000, tailN: 100000, tailRows: 5000, tailCols: 500, reverseStarts: 50, reverseLocal: 200, reverseBisect: 40, series: 10000, disclosures: 5000, textChars: 20000, posts: 1500 });

const missing = (engine, modelId, what) => makeResult({ engine, modelId, status: STATUS.INSUFFICIENT_OBSERVABILITY, unobserved: [what], coverage: coverageOf(0, 1), parameters: {}, notes: [`required input section "${what}" not supplied`] });

function weightsOf(system) {
  const px = Object.fromEntries(system.assets.map((a) => [a.id, a.price]));
  return system.funds.map((f) => {
    const vals = Object.fromEntries((f.holdings || []).map((h) => [h.asset, h.shares * px[h.asset]]));
    const total = Object.values(vals).reduce((s, v) => s + v, 0) + f.cash;
    return { id: f.id, weights: Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, v / total])), total };
  });
}

const RUNNERS = {
  cascade: (r) => (r.fundSystem ? [runCascade(r.fundSystem, r.scenario || {}, r.options || {})] : [missing('cascade', 'M10.cascade', 'fundSystem')]),
  counterfactual: (r) => (r.fundSystem ? [counterfactuals(r.fundSystem, r.scenario || {}, r.options || {})] : [missing('counterfactual', 'M15.counterfactual', 'fundSystem')]),
  reverseStress: (r, ctx) => (r.fundSystem && r.reverseStress ? [reverseStress({ system: r.fundSystem, rng: ctx.rng, options: r.options || {}, ...r.reverseStress })] : [missing('reverseStress', 'M13.reverse_stress', 'fundSystem+reverseStress')]),
  tailRisk: (r, ctx) => (r.tail ? [tailRisk({ rng: ctx.rng, ...r.tail })] : [missing('tailRisk', 'M11.tail', 'tail')]),
  concentration: (r) => (r.fundSystem ? weightsOf(r.fundSystem).map((f) => hhi(Object.entries(f.weights).map(([id, w]) => ({ id, w })))) : [missing('concentration', 'M02.hhi', 'fundSystem')]),
  overlap: (r) => {
    if (!r.fundSystem) return [missing('overlap', 'M03.overlap', 'fundSystem')];
    const w = weightsOf(r.fundSystem); const ov = overlapMatrix(w.map((f) => ({ id: f.id, weights: f.weights })));
    return ov.value ? [ov, analyzeNetwork({ ids: ov.value.ids, overlap: ov.value.overlap })] : [ov];
  },
  anomaly: (r, ctx) => (r.anomaly ? [detectAnomalies({ seed: ctx.seed, ...r.anomaly })] : [missing('anomaly', 'M20.anomaly_ensemble', 'anomaly')]),
  fundamentals: (r) => (r.statements ? [fundamentalMetrics(r.statements.current, r.statements.prior)] : [missing('fundamentals', 'M30.fundamentals', 'statements')]),
  accountingQuality: (r) => (r.statements ? [accountingQuality({ current: r.statements.current, prior: r.statements.prior, ...(r.accounting || {}) })] : [missing('accountingQuality', 'M33.accounting_quality', 'statements')]),
  valuation: (r) => (r.valuation ? [valuationDivergence(r.valuation)] : [missing('valuation', 'M31.valuation', 'valuation')]),
  divergence: (r) => (r.divergence ? [fundamentalPriceDivergence(r.divergence)] : [missing('divergence', 'M32.divergence', 'divergence')]),
  integrity: (r) => (r.integrity ? [pumpDumpPattern(r.integrity)] : [missing('integrity', 'M50.pump_dump_pattern', 'integrity')]),
  attention: (r) => (r.attention ? [attentionAnomaly(r.attention)] : [missing('attention', 'M51.attention', 'attention')]),
  coordination: (r) => (r.coordination ? [detectCoordination(r.coordination)] : [missing('coordination', 'M52.coordination', 'coordination')]),
  disclosure: (r) => (r.disclosures ? [disclosureEvents(r.disclosures, r.asOf)] : [missing('disclosure', 'M40.disclosure_rules', 'disclosures')]),
};

/** Validates the request envelope. Returns an error string or null. */
export function validateRequest(req) {
  if (!req || typeof req !== 'object') return 'body required';
  if (!Number.isInteger(req.seed)) return 'integer seed required (reproducibility)';
  if (!Array.isArray(req.engines) || !req.engines.length || req.engines.some((e) => !ENGINE_NAMES.includes(e))) return `engines must be a non-empty subset of ${ENGINE_NAMES.join(',')}`;
  if (req.observations && (!Array.isArray(req.observations) || req.observations.length > MAX_OBSERVATIONS)) return `observations must be an array of at most ${MAX_OBSERVATIONS}`;
  if (req.observations?.length && !req.asOf) return 'asOf required with observations';
  if (req.fundSystem) {
    if (req.fundSystem.funds?.length > LIMITS.funds || req.fundSystem.assets?.length > LIMITS.assets) return `fundSystem exceeds ${LIMITS.funds} funds / ${LIMITS.assets} assets`;
    const e = validateSystem(req.fundSystem); if (e) return `fundSystem: ${e}`;
  }
  const t = req.tail;
  if (t && ((t.N ?? 10000) > LIMITS.tailN || (t.returns?.length ?? 0) > LIMITS.tailRows || (t.returns?.[0]?.length ?? 0) > LIMITS.tailCols)) return 'tail request exceeds size limits';
  const rs = req.reverseStress;
  if (rs && ((rs.nStarts ?? 12) > LIMITS.reverseStarts || (rs.nLocal ?? 40) > LIMITS.reverseLocal || (rs.nBisect ?? 28) > LIMITS.reverseBisect)) return 'reverseStress search budget exceeds limits';
  if (req.anomaly && ((req.anomaly.reference?.length ?? 0) > LIMITS.series || (req.anomaly.evaluation?.length ?? 0) > LIMITS.series)) return 'anomaly series exceeds size limit';
  if (req.disclosures && (req.disclosures.length > LIMITS.disclosures || req.disclosures.some((d) => String(d?.title ?? '').length + String(d?.body ?? '').length > LIMITS.textChars))) return 'disclosures exceed size limits';
  if (req.coordination && ((req.coordination.evalPosts?.length ?? 0) > LIMITS.posts || (req.coordination.referencePosts?.length ?? 0) > 20 * LIMITS.posts)) return 'coordination posts exceed size limits';
  return null;
}

/**
 * Orchestrates one SFRE run: PIT snapshot -> engines -> evidence ledger -> reproducibility record.
 * deps: {ledger, registry, clock}. Engines never mutate inputs; every result is bound to a ledger claim.
 */
export function runPipeline(request, { ledger, registry = null, clock = () => new Date().toISOString() }) {
  const err = validateRequest(request);
  if (err) throw Object.assign(new Error(err), { code: 'INVALID_REQUEST' });
  const ctx = { seed: request.seed, rng: new Rng(request.seed) };

  let snapshot = null;
  if (request.observations?.length) {
    const store = new PitStore();
    for (const o of request.observations) store.add(o.hash && o.id ? o : makeObservation(o));
    const view = store.asOf(request.asOf); // look-ahead firewall: later observations are excluded from the snapshot
    snapshot = createSnapshot(view.observations, { asOf: request.asOf, label: request.label ?? null });
  }

  const results = []; const claims = {};
  for (const name of request.engines) {
    let out;
    try { out = RUNNERS[name](request, ctx); } catch (e) { out = [failed(name, name, e?.message || String(e))]; }
    for (const res of out) {
      results.push(res);
      const claimId = ledger.recordClaim({ claim: `${res.engine}:${res.model_id}:${res.status}`, result: res, snapshot });
      claims[res.result_hash] = claimId;
    }
  }
  const models = [...new Map(results.map((r) => [`${r.model_id}@${r.model_version}`, { model_id: r.model_id, version: r.model_version, state: registry?.get(r.model_id, r.model_version)?.state ?? 'UNREGISTERED' }])).values()];
  const run = createRunRecord({ snapshot, models, parameters: { engines: request.engines, scenario: request.scenario ?? null, options: request.options ?? null, inputHash: hashOf(request.fundSystem ?? null) }, seed: request.seed, results, startedAt: clock() });
  const nonProduction = models.filter((m) => m.state !== 'APPROVED').map((m) => m.model_id);
  return { run, results, claims, snapshot: snapshot && { snapshot_id: snapshot.snapshot_id, content_hash: snapshot.content_hash, asOf: snapshot.asOf, count: snapshot.count }, production_status: nonProduction.length ? 'NON_PRODUCTION' : 'APPROVED', non_production_models: nonProduction };
}
