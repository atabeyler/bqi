import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../lib/rbac.js';
import { computeSecurityScore } from '../services/securityScore.js';
import { computeCoverageScore } from '../services/coverageScore.js';

export const riskRouter = Router();

riskRouter.use(requireAuth);

// Both scores are read together in practice (spec section 29: a security
// score is only meaningful alongside its coverage), but are two separate
// pure-ish computations, so they're exposed as two endpoints rather than
// forcing every caller to always pay for both.
riskRouter.get('/security-score', requirePermission('report:view'), async (req, res) => {
  res.json(await computeSecurityScore(req.auth.orgId));
});

riskRouter.get('/coverage-score', requirePermission('report:view'), async (req, res) => {
  res.json(await computeCoverageScore(req.auth.orgId));
});
