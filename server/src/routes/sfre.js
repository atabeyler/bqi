import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole, ROLES, resolveRole } from '../lib/rbac.js';
import { logger } from '../lib/logger.js';
import { runInWorker } from '../sfre/jobs/runner.js';
import { recordRun, validateRequest } from '../sfre/pipeline.js';
import { EvidenceLedger } from '../sfre/evidence/ledger.js';
import { ModelRegistry, createDefaultRegistry, GovernanceError } from '../sfre/governance/modelRegistry.js';
import { explainResults } from '../sfre/ai/firewall.js';
import { buildRetailRiskTable } from '../sfre/alerts/retailRiskTable.js';
import { MemoryStore } from '../sfre/storage/store.js';
import { PgStore } from '../sfre/storage/pgStore.js';
import { defaultProviders } from '../sfre/research/providers.js';
import { ResearchRegistry } from '../sfre/research/registry.js';
import { analysisLimiter } from '../middleware/rateLimit.js';

/**
 * /api/sfre -- Systemic Financial Risk & Market Integrity Engine.
 * Analytical measurement under stated uncertainty: never investment advice, never an allegation.
 * Persistence: PostgreSQL when `pg` is supplied (production: DATABASE_URL), otherwise process memory (dev/tests).
 * Heavy computation runs in a worker thread with timeout + concurrency cap.
 */
export function createSfreRouter({ store = null, pg = null, ledger = null, registry = null, explainLlm = null, research = null, runner = runInWorker } = {}) {
  const router = express.Router();
  const mem = store || new MemoryStore();
  const db = pg ? new PgStore(pg) : null;
  let state = null; // {ledger, registry}
  let initializing = null;
  const ready = () => {
    if (state) return Promise.resolve(state);
    // single-flight: concurrent first requests share one initialisation; a failure is not cached (next request retries)
    initializing ||= init().finally(() => { initializing = null; });
    return initializing;
  };
  const init = async () => {
    let l = ledger; let r = registry;
    if (db) {
      await db.ensureSchema();
      l = l || await db.loadLedger();
      r = r || new ModelRegistry().loadState(await db.loadModels());
      if (!r.list().length) { r = createDefaultRegistry(); await db.saveModels(r); }
    }
    state = { ledger: l || new EvidenceLedger(), registry: r || createDefaultRegistry() };
    return state;
  };
  const S = db || mem; // run/result/claim-owner store
  const canRead = (req, owner) => resolveRole(req.user) === ROLES.ADMIN || owner === req.user.userCode;
  const providers = research || new ResearchRegistry(defaultProviders());

  router.use(authMiddleware);
  router.use(async (_req, res, next) => { try { await ready(); next(); } catch (e) { logger.error({ err: e }, '[SFRE] init failed'); res.status(503).json({ error: 'SFRE storage unavailable' }); } });

  router.get('/health', async (_req, res) => {
    const { ledger: l, registry: r } = state;
    res.json({ ok: true, engine: 'SFRE', version: '1.0.0', storage: db ? 'postgres' : 'memory', models: r.list().length, ledger: l.verify(), providers: providers.list() });
  });

  router.get('/data/status', requireRole(ROLES.ADMIN, ROLES.ANALYST), async (_req, res) => {
    if (!db) return res.json({ storage: 'memory', observations: null, note: 'no database configured: no persisted observations' });
    const r = await pg('SELECT source, field, count(*)::int AS n, min(available_time) AS first_available, max(available_time) AS last_available FROM sfre_observations GROUP BY source, field ORDER BY source, field');
    res.json({ storage: 'postgres', datasets: r.rows });
  });

  router.get('/models', (_req, res) => res.json({ models: state.registry.list().map((m) => ({ model_id: m.model_id, version: m.version, state: m.state, calibration: m.calibration, approved_use: m.approved_use })) }));

  router.post('/models/:id/transition', requireRole(ROLES.ADMIN), async (req, res) => {
    const { version = '1.0.0', to, evidence } = req.body || {};
    try {
      // the acting identity is the authenticated user, never the request body; API callers are 'human'
      const rec = state.registry.transition(req.params.id, version, to, { actor: { id: req.user.userCode, kind: 'human' }, evidence });
      if (db) await db.saveModels(state.registry);
      res.json({ model: { model_id: rec.model_id, version: rec.version, state: rec.state, calibration: rec.calibration, approved_use: rec.approved_use } });
    } catch (e) {
      if (e instanceof GovernanceError) return res.status(409).json({ error: e.message });
      logger.error({ err: e }, '[SFRE] transition failed');
      res.status(500).json({ error: 'internal error' });
    }
  });

  router.post('/runs', analysisLimiter, requireRole(ROLES.ADMIN, ROLES.ANALYST), async (req, res) => {
    try {
      const bad = validateRequest(req.body); if (bad) return res.status(400).json({ error: bad });
      const states = Object.fromEntries(state.registry.list().map((m) => [`${m.model_id}@${m.version}`, m.state]));
      const out = recordRun(await runner(req.body, states), state.ledger);
      await S.append('runs', { ...out.run, id: out.run.run_id, created_by: req.user.userCode });
      await S.append('results', { id: out.run.run_id, results: out.results, claims: out.claims, created_by: req.user.userCode });
      for (const claimId of Object.values(out.claims)) await S.append('claim_owners', { id: claimId, created_by: req.user.userCode });
      if (db) await db.saveLedger(state.ledger);
      const byKey = {}; for (const r of out.results) byKey[r.engine] ||= r;
      res.status(201).json({ run: out.run, production_status: out.production_status, non_production_models: out.non_production_models, snapshot: out.snapshot, results: out.results, claims: out.claims, retail_table: buildRetailRiskTable({ contagion: byKey.cascade, price_anomaly: byKey.anomaly, concentration: byKey.concentration, liquidity: byKey.liquidity, fundamental_divergence: byKey.divergence, valuation_divergence: byKey.valuation, attention_promotion: byKey.attention }) });
    } catch (e) {
      if (e.code === 'INVALID_REQUEST') return res.status(400).json({ error: e.message });
      if (e.code === 'BUSY') return res.status(429).json({ error: 'SFRE is busy, retry shortly' });
      if (e.code === 'TIMEOUT') return res.status(504).json({ error: 'run exceeded the time limit; reduce the request size' });
      logger.error({ err: e }, '[SFRE] run failed');
      res.status(500).json({ error: 'internal error' });
    }
  });

  router.get('/runs/:id', requireRole(ROLES.ADMIN, ROLES.ANALYST, ROLES.VIEWER), async (req, res) => {
    const run = await S.get('runs', req.params.id); if (!run || !canRead(req, run.created_by)) return res.status(404).json({ error: 'not found' });
    res.json({ run, results: await S.get('results', req.params.id) });
  });

  router.get('/claims/:claimId/explain', requireRole(ROLES.ADMIN, ROLES.ANALYST, ROLES.VIEWER), async (req, res) => {
    const owner = await S.get('claim_owners', req.params.claimId);
    const ex = owner && canRead(req, owner.created_by) ? state.ledger.explain(req.params.claimId) : null;
    if (!ex) return res.status(404).json({ error: 'claim not found' });
    res.json(ex); // evidence graph, not LLM text
  });

  router.post('/runs/:id/narrative', analysisLimiter, requireRole(ROLES.ADMIN, ROLES.ANALYST), async (req, res) => {
    const rec = await S.get('results', req.params.id); if (!rec || !canRead(req, rec.created_by)) return res.status(404).json({ error: 'not found' });
    res.json(await explainResults({ results: rec.results, llm: explainLlm }));
  });

  return router;
}

// Default instance: PostgreSQL when DATABASE_URL is configured (same pool as the rest of BQI), memory otherwise.
let defaultRouter = null;
export default function sfreRouter(req, res, next) {
  if (!defaultRouter) {
    if (process.env.DATABASE_URL) {
      import('../services/database.js').then(({ query }) => { defaultRouter = createSfreRouter({ pg: query }); defaultRouter(req, res, next); }).catch(next);
      return;
    }
    defaultRouter = createSfreRouter();
  }
  defaultRouter(req, res, next);
}
