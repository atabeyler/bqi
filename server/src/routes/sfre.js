import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole, ROLES, resolveRole } from '../lib/rbac.js';
import { logger } from '../lib/logger.js';
import { runPipeline } from '../sfre/pipeline.js';
import { EvidenceLedger } from '../sfre/evidence/ledger.js';
import { createDefaultRegistry, GovernanceError } from '../sfre/governance/modelRegistry.js';
import { explainResults } from '../sfre/ai/firewall.js';
import { buildRetailRiskTable } from '../sfre/alerts/retailRiskTable.js';
import { MemoryStore } from '../sfre/storage/store.js';
import { analysisLimiter } from '../middleware/rateLimit.js';

/**
 * /api/sfre -- Systemic Financial Risk & Market Integrity Engine.
 * All output is analytical measurement under stated uncertainty: never investment advice, never an allegation.
 * Factory form so tests can inject stores/registry; the default export uses process-lifetime in-memory state
 * (production persistence: sfre/storage/schema.sql, NOT yet wired -- see docs/sfre/ARCHITECTURE.md).
 */
export function createSfreRouter({ store = new MemoryStore(), ledger = new EvidenceLedger(), registry = createDefaultRegistry(), explainLlm = null } = {}) {
  const router = express.Router();
  // runs/claims are visible to their creator and to admins only (404, not 403, so ids cannot be probed)
  const canRead = (req, owner) => resolveRole(req.user) === ROLES.ADMIN || owner === req.user.userCode;
  router.use(authMiddleware);

  router.get('/health', (_req, res) => res.json({ ok: true, engine: 'SFRE', version: '1.0.0', models: registry.list().length, ledger: ledger.verify() }));

  router.get('/models', (_req, res) => res.json({ models: registry.list().map((m) => ({ model_id: m.model_id, version: m.version, state: m.state, calibration: m.calibration, approved_use: m.approved_use })) }));

  router.post('/models/:id/transition', requireRole(ROLES.ADMIN), (req, res) => {
    const { version = '1.0.0', to, evidence } = req.body || {};
    try {
      // the acting identity is taken from the authenticated token, never from the body; API callers are always 'human'
      const rec = registry.transition(req.params.id, version, to, { actor: { id: req.user.userCode, kind: 'human' }, evidence });
      res.json({ model: { model_id: rec.model_id, version: rec.version, state: rec.state, calibration: rec.calibration, approved_use: rec.approved_use } });
    } catch (e) {
      if (e instanceof GovernanceError) return res.status(409).json({ error: e.message });
      logger.error({ err: e }, '[SFRE] transition failed');
      res.status(500).json({ error: 'internal error' });
    }
  });

  router.post('/runs', analysisLimiter, requireRole(ROLES.ADMIN, ROLES.ANALYST), (req, res) => {
    try {
      const out = runPipeline(req.body, { ledger, registry });
      store.append('runs', { ...out.run, id: out.run.run_id, created_by: req.user.userCode });
      store.append('results', { id: out.run.run_id, results: out.results, claims: out.claims, created_by: req.user.userCode });
      for (const claimId of Object.values(out.claims)) store.append('claim_owners', { id: claimId, created_by: req.user.userCode });
      const byKey = {}; for (const r of out.results) byKey[r.engine] ||= r;
      res.status(201).json({ run: out.run, production_status: out.production_status, non_production_models: out.non_production_models, snapshot: out.snapshot, results: out.results, claims: out.claims, retail_table: buildRetailRiskTable({ contagion: byKey.cascade, price_anomaly: byKey.anomaly, concentration: byKey.concentration, liquidity: byKey.liquidity, fundamental_divergence: byKey.divergence, valuation_divergence: byKey.valuation, attention_promotion: byKey.attention }) });
    } catch (e) {
      if (e.code === 'INVALID_REQUEST') return res.status(400).json({ error: e.message });
      logger.error({ err: e }, '[SFRE] run failed');
      res.status(500).json({ error: 'internal error' });
    }
  });

  router.get('/runs/:id', requireRole(ROLES.ADMIN, ROLES.ANALYST, ROLES.VIEWER), (req, res) => {
    const run = store.get('runs', req.params.id); if (!run || !canRead(req, run.created_by)) return res.status(404).json({ error: 'not found' });
    res.json({ run, results: store.get('results', req.params.id) });
  });

  router.get('/claims/:claimId/explain', requireRole(ROLES.ADMIN, ROLES.ANALYST, ROLES.VIEWER), (req, res) => {
    const owner = store.get('claim_owners', req.params.claimId);
    const ex = owner && canRead(req, owner.created_by) ? ledger.explain(req.params.claimId) : null;
    if (!ex) return res.status(404).json({ error: 'claim not found' });
    res.json(ex); // evidence graph, not LLM text
  });

  router.post('/runs/:id/narrative', analysisLimiter, requireRole(ROLES.ADMIN, ROLES.ANALYST), async (req, res) => {
    const rec = store.get('results', req.params.id); if (!rec || !canRead(req, rec.created_by)) return res.status(404).json({ error: 'not found' });
    const out = await explainResults({ results: rec.results, llm: explainLlm });
    res.json(out);
  });

  return router;
}

export default createSfreRouter();
