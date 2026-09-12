import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../lib/rbac.js';
import { getOrEnrichVulnerability, syncKev, getFreshness } from '../services/intelligence.js';
import { verifyExploitationClaim } from '../services/decisionSupport.js';
import { recordAuditEvent } from '../services/audit.js';

export const intelligenceRouter = Router();

intelligenceRouter.use(requireAuth);

const cveIdSchema = z.string().regex(/^CVE-\d{4}-\d{4,}$/);

intelligenceRouter.get('/vulnerabilities/:cveId', requirePermission('intel:view'), async (req, res) => {
  const parsed = cveIdSchema.safeParse(req.params.cveId);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_cve_id', requestId: req.id });
  }
  const vulnerability = await getOrEnrichVulnerability(parsed.data);
  if (!vulnerability) {
    return res.status(404).json({ error: 'vulnerability_not_found', requestId: req.id });
  }
  res.json({ vulnerability });
});

// Spec section 42: an "actively exploited" claim (from AI or anywhere
// else) is never taken on its own word -- this checks it against BCI's own
// intelligence knowledge base (M8) before it's reported as confirmed.
intelligenceRouter.get('/vulnerabilities/:cveId/exploitation-claim', requirePermission('intel:view'), async (req, res) => {
  const parsed = cveIdSchema.safeParse(req.params.cveId);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_cve_id', requestId: req.id });
  res.json(await verifyExploitationClaim(parsed.data));
});

intelligenceRouter.get('/freshness', requirePermission('intel:view'), async (_req, res) => {
  res.json({ sources: await getFreshness() });
});

// A full-catalog sync is an administrative action (real outbound network
// calls to a third-party feed) -- gated behind intel:manage, not intel:view.
intelligenceRouter.post('/sync-kev', requirePermission('intel:manage'), async (req, res) => {
  const result = await syncKev();
  await recordAuditEvent({
    orgId: req.auth.orgId,
    actorUserId: req.auth.userId,
    action: 'intelligence.sync_kev',
    result: result.status === 'SUCCESS' ? 'SUCCESS' : 'FAILURE',
    metadata: result,
  });
  res.json(result);
});
