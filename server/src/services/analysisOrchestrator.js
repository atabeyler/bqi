import { logger } from '../lib/logger.js';

/**
 * Central orchestration primitives for BQI analysis flows.
 *
 * The user should not have to choose or compare internal engines. This layer
 * keeps provenance, quality checks and execution stages behind the scenes so
 * routes can return one clear decision-support result while the platform
 * retains an auditable execution trace.
 */

export const DATA_SOURCE_TYPES = Object.freeze({
  AI_GENERATED: 'ai-generated',
  UPLOADED: 'uploaded',
  INSTITUTIONAL_API: 'institutional-api',
  MANUAL: 'manual',
});

export function resolveDataProvenance({
  hasUploadedDocument = false,
  hasRealTransactions = false,
  hasRealScenarios = false,
  hasRealOptimization = false,
  institutionalSource = null,
} = {}) {
  if (institutionalSource) {
    return {
      type: DATA_SOURCE_TYPES.INSTITUTIONAL_API,
      source: institutionalSource,
      verifiedInput: true,
    };
  }

  if (hasRealTransactions || hasRealScenarios || hasRealOptimization || hasUploadedDocument) {
    return {
      type: DATA_SOURCE_TYPES.UPLOADED,
      source: 'user-upload',
      verifiedInput: hasRealTransactions || hasRealScenarios || hasRealOptimization,
    };
  }

  return {
    type: DATA_SOURCE_TYPES.AI_GENERATED,
    source: 'model-generated',
    verifiedInput: false,
  };
}

export const RESULT_SOURCE_TYPES = Object.freeze({
  AI_ESTIMATE: 'ai_estimate',
  QISKIT_AER_SIMULATION: 'qiskit_aer_simulation',
  IBM_HARDWARE_VERIFIED: 'ibm_hardware_verified',
});

/**
 * Normalizes the three quantum engines' backend/hardwareVerification shape
 * into one consistent label so the UI/reports can show a single, unambiguous
 * "where did this number come from" badge instead of reading engine-specific
 * fields: AI's own estimate (Python worker unavailable/skipped), the local
 * Qiskit Aer circuit simulator, or a result additionally confirmed on real
 * IBM Quantum hardware.
 */
export function resolveResultSource(computation) {
  if (!computation) return RESULT_SOURCE_TYPES.AI_ESTIMATE;
  // All three engines (scenario, fraud, portfolio optimizer) report a
  // separate hardwareVerification sub-result alongside the always-present,
  // always-authoritative simulator result -- `backend` itself never swaps to
  // an IBM backend name, so hardware confirmation is only ever additive.
  if (computation.hardwareVerification) return RESULT_SOURCE_TYPES.IBM_HARDWARE_VERIFIED;
  if (computation.backend && computation.backend !== 'qiskit-aer-simulator') return RESULT_SOURCE_TYPES.IBM_HARDWARE_VERIFIED;
  return RESULT_SOURCE_TYPES.QISKIT_AER_SIMULATION;
}

// How much of the expected data is actually present -- verified real
// records (uploaded/institutional) score far higher than an AI-generated
// stand-in, and a larger verified record count nudges it further up.
function computeCompleteness({ provenance, recordCount }) {
  if (!provenance?.verifiedInput) return 50;
  return Math.min(100, 90 + Math.min(10, Math.floor(recordCount / 10)));
}

// How recent the underlying data is. An explicit `asOfDate` (when the
// caller knows it) is used directly; otherwise this falls back to a
// provenance-based estimate (a live institutional feed is assumed current,
// an upload is a point-in-time snapshot, and AI-generated content has no
// real temporal anchor at all).
function computeFreshness({ provenance, asOfDate }) {
  if (asOfDate) {
    const ageDays = (Date.now() - new Date(asOfDate).getTime()) / 86400000;
    if (ageDays <= 1) return 100;
    if (ageDays <= 7) return 90;
    if (ageDays <= 30) return 75;
    if (ageDays <= 90) return 55;
    return 30;
  }
  if (provenance?.type === DATA_SOURCE_TYPES.INSTITUTIONAL_API) return 90;
  if (provenance?.type === DATA_SOURCE_TYPES.UPLOADED) return 70;
  return 50;
}

// Internal coherence of the analysis -- each data-quality warning raised
// during the run (parsing ambiguity, truncation, missing fields, etc.)
// lowers this; floors at 40 rather than 0 since a warning flags a specific
// issue, not a wholesale failure of the rest of the data.
function computeConsistency({ warnings }) {
  return Math.max(40, 100 - Math.min(60, (warnings?.length || 0) * 15));
}

// Trustworthiness of the source itself, independent of how much data it
// provided or how fresh it is.
function computeAuthority({ provenance }) {
  switch (provenance?.type) {
    case DATA_SOURCE_TYPES.INSTITUTIONAL_API: return 95;
    case DATA_SOURCE_TYPES.UPLOADED: return 80;
    case DATA_SOURCE_TYPES.MANUAL: return 70;
    default: return 50;
  }
}

/**
 * Breaks data quality into four independently-computed sub-metrics
 * (completeness, freshness, consistency, source authority) instead of one
 * opaque blended score, while still returning the same overall
 * score/level/warningCount shape existing callers rely on.
 *
 * IMPORTANT: `score` is a heuristic indicator, not a statistically
 * validated confidence measure -- the sub-metric weights (0.3/0.15/0.25/0.3
 * above) and computeAuthority()'s per-source-type points are fixed values
 * chosen by hand, not fitted or calibrated against outcomes. Any UI or
 * report surfacing this MUST label it as an internal indicator (e.g. "Data
 * Quality Indicator"), never as a validated "confidence score" -- and
 * should include `qualityModelVersion` alongside it, so a report stays
 * traceable to the weighting scheme that produced it if these weights
 * change later.
 */
export const DATA_QUALITY_MODEL_VERSION = 'DQ-1.0';

export function assessDataQuality({ provenance, recordCount = 0, warnings = [], asOfDate = null } = {}) {
  const completeness = computeCompleteness({ provenance, recordCount });
  const freshness = computeFreshness({ provenance, asOfDate });
  const consistency = computeConsistency({ warnings });
  const authority = computeAuthority({ provenance });

  // Completeness and authority weighted heaviest -- whether real data was
  // actually supplied, and how trustworthy that source is, matter more to
  // an analysis' reliability than freshness or the (already-punitive)
  // consistency warning count.
  const score = Math.round(completeness * 0.3 + freshness * 0.15 + consistency * 0.25 + authority * 0.3);

  return {
    score,
    level: score >= 85 ? 'high' : score >= 65 ? 'medium' : 'limited',
    warningCount: warnings?.length || 0,
    metrics: { completeness, freshness, consistency, authority },
    qualityModelVersion: DATA_QUALITY_MODEL_VERSION,
  };
}

export function createDecisionTrace({ category, quantumMode, provenance, dataQuality } = {}) {
  const startedAt = new Date().toISOString();
  return {
    version: 1,
    startedAt,
    category: category || null,
    quantumRequested: !!quantumMode,
    provenance: provenance || null,
    dataQuality: dataQuality || null,
    stages: [
      { stage: 'ingest', status: 'completed', at: startedAt },
      { stage: 'validate', status: 'completed', at: startedAt },
      { stage: 'normalize', status: 'completed', at: startedAt },
    ],
  };
}

export function markDecisionStage(trace, stage, status = 'completed', metadata = null) {
  if (!trace?.stages) return trace;
  trace.stages.push({
    stage,
    status,
    at: new Date().toISOString(),
    ...(metadata ? { metadata } : {}),
  });
  return trace;
}

export function buildEvidenceSummary({ provenance, dataQuality, provider, quantum, fraud, optimizer } = {}) {
  return {
    source: provenance?.type || DATA_SOURCE_TYPES.AI_GENERATED,
    sourceName: provenance?.source || null,
    dataQuality: dataQuality || null,
    aiProvider: provider || null,
    quantum: quantum
      ? { backend: quantum.backend || null, shots: quantum.shots || null, dataSource: quantum.dataSource || null, resultSource: resolveResultSource(quantum) }
      : null,
    fraud: fraud
      ? { backend: fraud.backend || null, transactionCount: fraud.transactionCount || 0, flaggedCount: fraud.flaggedCount || 0, dataSource: fraud.dataSource || null, resultSource: resolveResultSource(fraud) }
      : null,
    optimizer: optimizer
      ? { backend: optimizer.backend || null, dataSource: optimizer.dataSource || null, resultSource: resolveResultSource(optimizer) }
      : null,
  };
}

/**
 * Executes named stages sequentially and records their outcome. It is kept
 * deliberately generic so generation, replay and future institutional
 * connector flows can share the same orchestration contract.
 */
export async function runAnalysisStages(trace, stages = []) {
  const results = {};
  for (const entry of stages) {
    const name = entry?.name;
    if (!name || typeof entry.run !== 'function') continue;
    const started = Date.now();
    try {
      results[name] = await entry.run(results);
      markDecisionStage(trace, name, 'completed', { durationMs: Date.now() - started });
    } catch (err) {
      markDecisionStage(trace, name, 'failed', { durationMs: Date.now() - started, error: err?.message || String(err) });
      logger.error({ err, stage: name }, '[AnalysisOrchestrator] stage failed');
      throw err;
    }
  }
  return results;
}
