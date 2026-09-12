import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { query } from '../services/database.js';
import { logger } from '../lib/logger.js';
import { getStatus as getAiStatus } from '../services/ai.js';
import { isIbmHardwareConfigured } from '../services/quantum.js';
import { checkQuantumWorkerHealth } from '../services/quantumProcess.js';
import { isS3Configured } from '../lib/objectStorage.js';
import { getConnectorStatuses, listConnectors } from '../services/connectors.js';
import { getMetricsSnapshot } from '../lib/requestMetrics.js';
import { canAccessClassification, requireRole, ROLES } from '../lib/rbac.js';
import {
  ANALYSIS_PROMPT_VERSION,
  DEFAULT_RETENTION_DAYS,
  getDecisionByAnalysisId,
  getDecisionOverview,
  getEngineAccuracyStats,
  getRiskOverview,
  publicModelRegistry,
  updateDecisionOutcome,
  verifyDecisionRecordIntegrity,
} from '../services/decisionIntelligence.js';

const router = express.Router();
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

const requireAdmin = requireRole(ROLES.ADMIN);

async function databaseHealth() {
  if (!process.env.DATABASE_URL) return { configured: false, ok: false };
  try {
    await query('SELECT 1');
    return { configured: true, ok: true };
  } catch (err) {
    return { configured: true, ok: false, error: err?.message || String(err) };
  }
}

router.get('/health/live', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), timestamp: Date.now() });
});

router.get('/health/ready', asyncRoute(async (req, res) => {
  const [db, quantumWorker] = await Promise.all([databaseHealth(), checkQuantumWorkerHealth()]);
  const ai = getAiStatus();
  const aiReady = Object.values(ai).some(Boolean);
  // Quantum worker health degrades readiness (not a hard failure): every
  // quantum-mode call already falls back to the LLM's own estimate when the
  // Python process is unavailable (see quantum.js/fraudDetection.js/
  // portfolioOptimizer.js), so a broken interpreter shouldn't take the whole
  // service out of rotation -- it's reported so operators can see it.
  const ready = aiReady && (!process.env.DATABASE_URL || db.ok);
  res.status(ready ? 200 : 503).json({
    ready,
    database: db,
    ai: { configured: aiReady, providers: ai },
    quantum: {
      simulatorExpected: true,
      workerOk: quantumWorker.ok,
      workerError: quantumWorker.ok ? null : quantumWorker.error,
      ibmConfigured: isIbmHardwareConfigured(),
    },
    storage: { persistentObjectStorageConfigured: isS3Configured() },
    redis: { configured: !!process.env.REDIS_URL },
  });
}));

router.use(authMiddleware);

router.get('/models', (req, res) => {
  res.json({ promptVersion: ANALYSIS_PROMPT_VERSION, models: publicModelRegistry() });
});

router.get('/connectors', requireAdmin, asyncRoute(async (req, res) => {
  const statuses = await getConnectorStatuses();
  res.json({ registered: listConnectors(), statuses });
}));

router.get('/metrics', requireAdmin, (req, res) => {
  res.json({ metrics: getMetricsSnapshot() });
});

router.get('/retention', requireAdmin, (req, res) => {
  res.json({ decisionRetentionDays: DEFAULT_RETENTION_DAYS });
});

router.get('/overview', requireAdmin, asyncRoute(async (req, res) => {
  const [database, connectors, decisions, risks] = await Promise.all([
    databaseHealth(),
    getConnectorStatuses(),
    getDecisionOverview(),
    getRiskOverview(10),
  ]);
  res.json({
    health: {
      database,
      ai: getAiStatus(),
      ibmQuantumConfigured: isIbmHardwareConfigured(),
      storageConfigured: isS3Configured(),
      redisConfigured: !!process.env.REDIS_URL,
    },
    connectors,
    decisions,
    recentRisks: risks,
    metrics: getMetricsSnapshot(),
  });
}));

router.get('/risk', requireAdmin, asyncRoute(async (req, res) => {
  res.json({ items: await getRiskOverview(req.query.limit) });
}));

// Aggregate AI/quantum engine accuracy from calibrated outcomes (see
// computeOutcomeCalibration in decisionIntelligence.js), grouped by
// category and model so engines can be compared on real historical
// decisions rather than judged per-report in isolation.
router.get('/decisions/accuracy', requireAdmin, asyncRoute(async (req, res) => {
  res.json({ stats: await getEngineAccuracyStats() });
}));

// getDecisionByAnalysisId already scopes non-admins to their own records;
// canAccessClassification is an additional ABAC layer on top of that
// ownership check -- a 'viewer'-role account (max INTERNAL) is still
// blocked from a CONFIDENTIAL/RESTRICTED record even if it's their own,
// e.g. a role downgrade after the fact or a shared/service account.
router.get('/decisions/:analysisId', asyncRoute(async (req, res) => {
  const record = await getDecisionByAnalysisId(Number(req.params.analysisId), req.user);
  if (!record) return res.status(404).json({ error: 'Karar izi bulunamadı' });
  if (!canAccessClassification(req.user, record.data_classification)) {
    return res.status(403).json({ error: 'Bu veri sınıfına erişim yetkiniz yok' });
  }
  res.json({ record });
}));

router.get('/decisions/:analysisId/integrity', asyncRoute(async (req, res) => {
  const record = await getDecisionByAnalysisId(Number(req.params.analysisId), req.user);
  if (!record) return res.status(404).json({ error: 'Karar izi bulunamadı' });
  if (!canAccessClassification(req.user, record.data_classification)) {
    return res.status(403).json({ error: 'Bu veri sınıfına erişim yetkiniz yok' });
  }
  res.json(verifyDecisionRecordIntegrity(record));
}));

router.post('/decisions/:analysisId/outcome', asyncRoute(async (req, res) => {
  const analysisId = Number(req.params.analysisId);
  const { status, summary, score, notes, actual } = req.body || {};
  if (!status && !summary && score === undefined && !notes && !actual) {
    return res.status(400).json({ error: 'Sonuç bilgisi gerekli' });
  }
  // `actual` (realizedScenarioId / confirmedFraudIds / realizedValue) drives
  // automatic calibration against what each engine predicted at analysis
  // time -- see computeOutcomeCalibration in decisionIntelligence.js.
  const record = await updateDecisionOutcome(analysisId, req.user, {
    status: status || null,
    summary: summary || null,
    score: Number.isFinite(Number(score)) ? Number(score) : null,
    notes: notes || null,
    actual: actual || null,
    recordedBy: req.user.userCode,
    recordedAt: new Date().toISOString(),
  });
  if (!record) return res.status(404).json({ error: 'Karar izi bulunamadı' });
  res.json({ success: true, record });
}));

router.post('/decisions/:analysisId/replay', asyncRoute(async (req, res) => {
  const analysisId = Number(req.params.analysisId);
  const record = await getDecisionByAnalysisId(analysisId, req.user);
  if (!record?.request_payload) return res.status(404).json({ error: 'Yeniden çalıştırılabilir analiz bulunamadı' });

  const port = process.env.PORT || 10000;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/analysis/generate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // req.token (set by authMiddleware) rather than the raw incoming
        // header -- a web caller authenticates via httpOnly cookie, which
        // this server-side loopback fetch wouldn't otherwise carry.
        authorization: `Bearer ${req.token}`,
        'x-bqi-replay-of': String(record.id),
      },
      body: JSON.stringify({ ...record.request_payload, ...req.body }),
      signal: AbortSignal.timeout(180000),
    });
    // /generate can fail before it ever reaches its own JSON error handler
    // (e.g. a proxy/timeout page, or an unhandled exception rendered by a
    // non-JSON error page) -- parsing that as JSON would throw and mask the
    // real upstream status/body behind a generic 502. Check content-type
    // first so a non-JSON response is surfaced as-is instead.
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await response.text();
      logger.warn({ status: response.status, contentType, bodyPreview: text.slice(0, 300) }, '[Platform] Replay got a non-JSON response from /api/analysis/generate');
      return res.status(502).json({ error: 'Analiz yeniden çalıştırılamadı', detail: `Beklenmeyen yanıt (HTTP ${response.status})` });
    }
    const payload = await response.json();
    return res.status(response.status).json({ ...payload, replayOfAnalysisId: analysisId });
  } catch (err) {
    return res.status(502).json({ error: 'Analiz yeniden çalıştırılamadı', detail: err?.message || String(err) });
  }
}));

export default router;
