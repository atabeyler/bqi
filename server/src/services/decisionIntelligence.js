import crypto from 'crypto';
import { query } from './database.js';
import { logger } from '../lib/logger.js';
import { CLASSIFICATIONS } from './dataEgressPolicy.js';

export const ANALYSIS_PROMPT_VERSION = '2026-08-12-v1';
export const DEFAULT_RETENTION_DAYS = Number(process.env.DECISION_RETENTION_DAYS || 365);
// BQI-009 (execution fingerprint): the quantum engines' pinned dependency
// versions (server/quantum/requirements.txt) -- a static, deploy-time value
// rather than a per-request round-trip from the Python worker (that would
// need reproducibility.js's environment_fingerprint() piped back through
// quantumJobQueue.js on every call, a materially larger change). Still
// genuinely answers "which engine version produced this" for any record,
// since it's bumped whenever the pinned requirements change.
export const QUANTUM_ENGINE_VERSION = 'qiskit==1.4.6;qiskit-aer==0.17.2;qiskit-ibm-runtime==0.44.0';

/**
 * Deterministic hash of a JSON-shaped value: sorts object keys recursively
 * so the same logical content always hashes the same way regardless of key
 * insertion order, then sha256s the canonical string. Used to make
 * decision records, evidence and analysis inputs tamper-evident.
 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = canonicalize(value[key]);
      return acc;
    }, {});
  }
  return value;
}

export function hashRecord(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value || {}))).digest('hex');
}

/**
 * Recomputes the input/evidence/record hashes from a stored decision_records
 * row and compares them against the hashes captured at write time. Returns
 * per-field ok flags plus an overall verdict — used to detect any
 * out-of-band modification of a record after it was saved.
 */
export function verifyDecisionRecordIntegrity(row) {
  if (!row) return { ok: false, reason: 'not-found' };
  const checks = {
    input: !row.input_hash || hashRecord(row.request_payload) === row.input_hash,
    evidence: !row.evidence_hash || hashRecord(row.evidence) === row.evidence_hash,
    record: !row.record_hash || hashRecord({
      analysisId: row.analysis_id,
      userCode: row.user_code,
      category: row.category,
      requestPayload: row.request_payload,
      provenance: row.provenance,
      dataQuality: row.data_quality,
      evidence: row.evidence,
      decisionTrace: row.decision_trace,
      aiProvider: row.ai_provider,
      promptVersion: row.prompt_version,
      dataClassification: row.data_classification,
    }) === row.record_hash,
  };
  return { ok: checks.input && checks.evidence && checks.record, checks };
}

export async function ensureDecisionTables() {
  if (!process.env.DATABASE_URL) return;
  await query(`
    CREATE TABLE IF NOT EXISTS decision_records (
      id SERIAL PRIMARY KEY,
      analysis_id INTEGER,
      replay_of INTEGER,
      user_code VARCHAR(50) NOT NULL,
      category VARCHAR(50),
      title TEXT,
      prompt TEXT,
      request_payload JSONB,
      provenance JSONB,
      data_quality JSONB,
      evidence JSONB,
      decision_trace JSONB,
      ai_provider VARCHAR(100),
      model_name VARCHAR(100),
      prompt_version VARCHAR(50),
      data_classification VARCHAR(30) DEFAULT 'INTERNAL',
      duration_ms INTEGER,
      outcome JSONB,
      outcome_updated_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await query(`ALTER TABLE decision_records ADD COLUMN IF NOT EXISTS input_hash VARCHAR(64);`);
  await query(`ALTER TABLE decision_records ADD COLUMN IF NOT EXISTS evidence_hash VARCHAR(64);`);
  await query(`ALTER TABLE decision_records ADD COLUMN IF NOT EXISTS record_hash VARCHAR(64);`);
  // Everything needed to reproduce an analysis' quantum-mode computations
  // exactly: backend/qubit/shot counts per engine plus the QAOA COBYLA seed
  // (see quantum/portfolio_optimizer.py) -- distinct from prompt_version/
  // model_name above, which cover the AI side of reproducibility.
  await query(`ALTER TABLE decision_records ADD COLUMN IF NOT EXISTS quantum_params JSONB;`);
  // What each engine actually predicted at analysis time (scenario
  // probabilities, fraud-flagged set, optimizer totals) -- compared against
  // the real-world outcome later recorded via updateDecisionOutcome() to
  // auto-calibrate engine accuracy (see computeOutcomeCalibration below).
  await query(`ALTER TABLE decision_records ADD COLUMN IF NOT EXISTS predicted_outcome JSONB;`);
  // BQI-009 execution fingerprint: which quantum engine build produced this
  // record's quantum_params, and the content hashes of every source that
  // fed the request (uploaded document + each quantum engine's own input
  // dataset hash) -- distinct from input_hash above, which hashes the
  // whole sanitized request as one unit rather than per-source.
  await query(`ALTER TABLE decision_records ADD COLUMN IF NOT EXISTS quantum_engine_version VARCHAR(200);`);
  await query(`ALTER TABLE decision_records ADD COLUMN IF NOT EXISTS source_hashes JSONB;`);
  await query(`CREATE INDEX IF NOT EXISTS idx_decision_records_analysis ON decision_records(analysis_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_decision_records_user ON decision_records(user_code, created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_decision_records_category ON decision_records(category, created_at DESC);`);
  logger.info('Decision intelligence tables ready');
}

function modelForProvider(provider = '') {
  if (provider.includes('Claude')) return 'claude-sonnet-4-6';
  if (provider.includes('Gemini')) return 'gemini-3.5-flash';
  if (provider.includes('GPT-4o')) return 'gpt-4o';
  return null;
}

// Higher index = more sensitive (see dataEgressPolicy.ts's CLASSIFICATIONS,
// the single source of truth for this ordering).
export function maxLevel(a, b) {
  const ai = CLASSIFICATIONS.indexOf(a);
  const bi = CLASSIFICATIONS.indexOf(b);
  if (ai === -1) return b;
  if (bi === -1) return a;
  return ai >= bi ? a : b;
}

export function classifyData(category, requested = null) {
  const categoryDefault = ['savunma', 'saldiri', 'bddk', 'btk', 'cok-alanli'].includes(category)
    ? 'CONFIDENTIAL'
    : (category ? 'INTERNAL' : null);

  const requestedUpper = requested ? String(requested).toUpperCase() : null;
  const requestedValid = requestedUpper && CLASSIFICATIONS.includes(requestedUpper) ? requestedUpper : null;

  // No category to derive a floor from -- requested (if valid) is the
  // legitimate way to set classification explicitly in that case.
  if (!categoryDefault) return requestedValid || 'INTERNAL';

  // requested may only ever RAISE the classification above the
  // category-derived default, never downgrade it (e.g. a client can't send
  // requested=PUBLIC to strip CONFIDENTIAL protection off a "savunma" record).
  return requestedValid ? maxLevel(categoryDefault, requestedValid) : categoryDefault;
}

export function publicModelRegistry() {
  return [
    { provider: 'Anthropic', model: 'claude-sonnet-4-6', purpose: 'analysis' },
    { provider: 'Google', model: 'gemini-3.5-flash', purpose: 'fallback-analysis' },
    { provider: 'Google', model: 'gemini-3.6-flash', purpose: 'fallback-analysis' },
    { provider: 'Google', model: 'gemini-3.5-flash-lite', purpose: 'fallback-analysis' },
    { provider: 'OpenAI', model: 'gpt-4o', purpose: 'fallback-analysis' },
    { provider: 'Anthropic', model: 'claude-haiku-4-5-20251001', purpose: 'voice-intent' },
  ];
}

export async function saveDecisionRecord({
  analysisId = null,
  replayOf = null,
  userCode,
  category,
  title,
  prompt,
  requestPayload,
  provenance,
  dataQuality,
  evidence,
  decisionTrace,
  aiProvider,
  dataClassification,
  durationMs,
  quantumParams,
  predictedOutcome,
  sourceHashes = [],
}) {
  if (!process.env.DATABASE_URL || !userCode) return null;
  try {
    const resolvedClassification = dataClassification || classifyData(category);
    const inputHash = hashRecord(requestPayload);
    const evidenceHash = hashRecord(evidence);
    const recordHash = hashRecord({
      analysisId, userCode, category: category || null, requestPayload: requestPayload || {},
      provenance: provenance || {}, dataQuality: dataQuality || {}, evidence: evidence || {},
      decisionTrace: decisionTrace || {}, aiProvider: aiProvider || null,
      promptVersion: ANALYSIS_PROMPT_VERSION, dataClassification: resolvedClassification,
    });
    const { rows } = await query(
      `INSERT INTO decision_records
       (analysis_id, replay_of, user_code, category, title, prompt, request_payload,
        provenance, data_quality, evidence, decision_trace, ai_provider, model_name,
        prompt_version, data_classification, duration_ms, input_hash, evidence_hash, record_hash,
        quantum_params, predicted_outcome, quantum_engine_version, source_hashes)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21::jsonb,$22,$23::jsonb)
       RETURNING id`,
      [
        analysisId, replayOf, userCode, category || null, title || null, prompt || null,
        JSON.stringify(requestPayload || {}), JSON.stringify(provenance || {}),
        JSON.stringify(dataQuality || {}), JSON.stringify(evidence || {}),
        JSON.stringify(decisionTrace || {}), aiProvider || null, modelForProvider(aiProvider),
        ANALYSIS_PROMPT_VERSION, resolvedClassification, durationMs || null,
        inputHash, evidenceHash, recordHash, JSON.stringify(quantumParams || {}),
        JSON.stringify(predictedOutcome || {}), QUANTUM_ENGINE_VERSION, JSON.stringify(sourceHashes || []),
      ]
    );
    return rows[0]?.id || null;
  } catch (err) {
    logger.warn({ err }, '[DecisionIntelligence] record write failed');
    return null;
  }
}

export async function getDecisionByAnalysisId(analysisId, user) {
  if (!process.env.DATABASE_URL) return null;
  const params = [analysisId];
  let sql = 'SELECT * FROM decision_records WHERE analysis_id = $1';
  if (!user?.isAdmin) {
    params.push(user?.userCode || '');
    sql += ' AND user_code = $2';
  }
  sql += ' ORDER BY created_at DESC LIMIT 1';
  const { rows } = await query(sql, params);
  return rows[0] || null;
}

/**
 * Compares what each engine predicted (see buildPredictedOutcome in
 * middleware/analysisTrace.js) against the real-world outcome supplied via
 * updateDecisionOutcome()'s `actual` field, producing a per-engine accuracy
 * score. Pure function so it's independently testable without a database.
 *
 * `actual` shape (all optional -- only present engines are scored):
 *   { realizedScenarioId, confirmedFraudIds: string[], realizedValue }
 */
export function computeOutcomeCalibration(predicted, actual) {
  if (!predicted || !actual) return null;
  const calibration = {};

  if (predicted.scenario?.candidates?.length && actual.realizedScenarioId) {
    const match = predicted.scenario.candidates.find((c) => c.id === actual.realizedScenarioId);
    calibration.scenario = {
      realizedScenarioId: actual.realizedScenarioId,
      predictedProbability: match?.probability ?? 0,
      // The engine "called it" well if it assigned a high probability to
      // the scenario that actually happened -- the predicted probability
      // itself is the accuracy score (0 if the realized scenario wasn't
      // even among the candidates it considered).
      accuracy: match?.probability ?? 0,
    };
  }

  if (predicted.fraud && Array.isArray(actual.confirmedFraudIds)) {
    const flagged = new Set(predicted.fraud.flaggedIds || []);
    const confirmed = new Set(actual.confirmedFraudIds);
    const truePositives = [...flagged].filter((id) => confirmed.has(id)).length;
    const precision = flagged.size ? truePositives / flagged.size : null;
    const recall = confirmed.size ? truePositives / confirmed.size : null;
    calibration.fraud = {
      precision, recall,
      f1: precision != null && recall != null && (precision + recall) > 0
        ? (2 * precision * recall) / (precision + recall)
        : null,
    };
  }

  if (predicted.optimizer && Number.isFinite(actual.realizedValue)) {
    const predictedValue = predicted.optimizer.totalValue || 0;
    const errorPercent = predictedValue > 0
      ? Math.abs(actual.realizedValue - predictedValue) / predictedValue * 100
      : null;
    calibration.optimizer = { predictedValue, realizedValue: actual.realizedValue, errorPercent };
  }

  return Object.keys(calibration).length ? calibration : null;
}

export async function updateDecisionOutcome(analysisId, user, outcome) {
  if (!process.env.DATABASE_URL) return null;
  const existing = await getDecisionByAnalysisId(analysisId, user);
  if (!existing) return null;

  const calibration = outcome?.actual
    ? computeOutcomeCalibration(existing.predicted_outcome, outcome.actual)
    : null;
  const outcomeToStore = calibration ? { ...outcome, calibration } : outcome;

  const { rows } = await query(
    `UPDATE decision_records SET outcome = $1::jsonb, outcome_updated_at = NOW()
     WHERE id = $2 RETURNING *`,
    [JSON.stringify(outcomeToStore || {}), existing.id]
  );
  return rows[0] || null;
}

/**
 * Aggregates recorded outcome calibrations by category, AI model, and
 * engine, so AI/quantum performance can be compared against real
 * historical decisions instead of judged in isolation per report.
 */
export async function getEngineAccuracyStats() {
  if (!process.env.DATABASE_URL) return [];
  const { rows } = await query(
    `SELECT category, model_name, outcome
     FROM decision_records
     WHERE outcome -> 'calibration' IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 2000`
  );

  const buckets = new Map();
  const bump = (key, engine, value) => {
    if (value == null || !Number.isFinite(value)) return;
    const bucket = buckets.get(key) || {};
    const engineBucket = bucket[engine] || { sum: 0, count: 0 };
    engineBucket.sum += value;
    engineBucket.count += 1;
    bucket[engine] = engineBucket;
    buckets.set(key, bucket);
  };

  for (const row of rows) {
    const key = `${row.category || 'unknown'}|${row.model_name || 'unknown'}`;
    const cal = row.outcome?.calibration;
    if (!cal) continue;
    if (cal.scenario) bump(key, 'scenario', cal.scenario.accuracy);
    if (cal.fraud) bump(key, 'fraud', cal.fraud.f1);
    if (cal.optimizer && cal.optimizer.errorPercent != null) bump(key, 'optimizer', 100 - Math.min(100, cal.optimizer.errorPercent));
  }

  return Array.from(buckets.entries()).map(([key, engines]) => {
    const [category, model] = key.split('|');
    return {
      category,
      model,
      engines: Object.fromEntries(
        Object.entries(engines).map(([engine, { sum, count }]) => [engine, { avgAccuracy: Math.round((sum / count) * 100) / 100, sampleSize: count }])
      ),
    };
  });
}

export async function getDecisionOverview() {
  if (!process.env.DATABASE_URL) {
    return { totalDecisions: 0, recentDecisions: 0, outcomesRecorded: 0, pendingApprovals: 0 };
  }
  const [decisionCounts, approvals] = await Promise.all([
    query(`SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS recent,
                  COUNT(*) FILTER (WHERE outcome IS NOT NULL)::int AS outcomes
           FROM decision_records`),
    query(`SELECT COUNT(*)::int AS count FROM approval_tokens
           WHERE approved = FALSE AND expires_at > NOW()`),
  ]);
  return {
    totalDecisions: decisionCounts.rows[0]?.total || 0,
    recentDecisions: decisionCounts.rows[0]?.recent || 0,
    outcomesRecorded: decisionCounts.rows[0]?.outcomes || 0,
    pendingApprovals: approvals.rows[0]?.count || 0,
  };
}

export async function getRiskOverview(limit = 25) {
  if (!process.env.DATABASE_URL) return [];
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
  const { rows } = await query(
    `SELECT id, user_code, category, title, ai_provider,
            fraud_transaction_count, fraud_flagged_count, created_at
     FROM analyses
     WHERE fraud_flagged_count IS NOT NULL OR category IN ('savunma','saldiri','bddk','btk','cok-alanli')
     ORDER BY created_at DESC LIMIT $1`,
    [safeLimit]
  );
  return rows.map((row) => ({
    ...row,
    flagRate: row.fraud_transaction_count
      ? Math.round((row.fraud_flagged_count / row.fraud_transaction_count) * 1000) / 10
      : null,
  }));
}

export async function purgeExpiredDecisionRecords() {
  if (!process.env.DATABASE_URL || !Number.isFinite(DEFAULT_RETENTION_DAYS) || DEFAULT_RETENTION_DAYS <= 0) return 0;
  const { rowCount } = await query(
    `DELETE FROM decision_records
     WHERE created_at < NOW() - ($1::text || ' days')::interval`,
    [String(DEFAULT_RETENTION_DAYS)]
  );
  return rowCount || 0;
}
