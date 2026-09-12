import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../lib/rbac.js';
import { syncSecurityGraph, findReachableAssets, getKnowledgeGraph } from '../services/securityGraph.js';
import { computeAttackPathPriorities, computePatchOrder, identifyDefensiveControlPlacements } from '../services/securityGraphOptimizer.js';

export const graphRouter = Router();

graphRouter.use(requireAuth);

graphRouter.post('/sync', requirePermission('asset:update'), async (req, res) => {
  res.json(await syncSecurityGraph(req.auth.orgId));
});

// Defensive attack-path analysis (spec section 31) -- read-only, so it only
// needs asset:view, not the write-level permission the sync above requires.
graphRouter.get('/assets/:assetId/reachable', requirePermission('asset:view'), async (req, res) => {
  const reachable = await findReachableAssets(req.auth.orgId, req.params.assetId);
  res.json({ reachable });
});

// Security Graph Optimizer (spec section 9) -- read-only ranking/analysis
// over the same graph, gated at finding:view since it's fundamentally a
// view over open findings' blast radius, never a write.
graphRouter.get('/attack-paths', requirePermission('finding:view'), async (req, res) => {
  res.json({ attackPaths: await computeAttackPathPriorities(req.auth.orgId) });
});

graphRouter.get('/patch-order', requirePermission('finding:view'), async (req, res) => {
  res.json({ patchOrder: await computePatchOrder(req.auth.orgId) });
});

graphRouter.get('/defensive-controls', requirePermission('finding:view'), async (req, res) => {
  res.json({ placements: await identifyDefensiveControlPlacements(req.auth.orgId) });
});

graphRouter.get('/knowledge', requirePermission('finding:view'), async (req, res) => {
  res.json(await getKnowledgeGraph(req.auth.orgId));
});
