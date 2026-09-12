/**
 * Cyber Analysis module -- BQI's user-facing surface for BCI (BOLD
 * Cyber Intelligence). Every route here proxies to the separately deployed
 * BCI service (see services/bciClient.js); nothing in this file talks to
 * BCI's database or reimplements any of its logic. Per spec section 56,
 * users see "BCI Vulnerability Analysis"/"BCI Risk Analysis" language here,
 * never the names of the third-party scanners BCI orchestrates underneath.
 */
import express from 'express';
import { URLSearchParams } from 'node:url';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole, ROLES } from '../lib/rbac.js';
import { callBci, isBciConfigured } from '../services/bciClient.js';
import { assessBciScan } from '../services/bciAiAdvisor.js';
import { proposeFuzzStrategy } from '../services/bciFuzzAdvisor.js';
import { proposeIntrusiveStrategy } from '../services/bciIntrusiveAdvisor.js';
import { proposeResilienceStrategy } from '../services/bciResilienceAdvisor.js';

const router = express.Router();
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

// Viewer role is intentionally excluded: Cyber Analysis surfaces
// organization-wide risk data, not the kind of thing every BQI
// account should see by default.
const requireAnalyst = requireRole(ROLES.ADMIN, ROLES.ANALYST);
// Controlled Proof performs several bounded, sequential network checks. Its
// normal execution can exceed the gateway's short dashboard timeout even
// while BCI remains healthy, so only this operation receives a larger budget.
// Controlled Proof now executes the bounded live engine set sequentially
// to avoid bursting requests against a production target. Keep the gateway
// above the sum of those engine budgets; a timeout must not be surfaced as
// the misleading generic `bci_unavailable` result.
const CONTROLLED_PROOF_ANALYZE_TIMEOUT_MS = 5 * 60_000;

router.use(authMiddleware, requireAnalyst);

router.get('/status', (_req, res) => {
  res.json({ available: isBciConfigured() });
});

router.get('/overview', asyncRoute(async (req, res) => {
  const [security, coverage] = await Promise.all([
    callBci(req.user, '/api/v1/risk/security-score'),
    callBci(req.user, '/api/v1/risk/coverage-score'),
  ]);

  if (!security.ok || !coverage.ok) {
    return res.status(503).json({ error: 'bci_unavailable' });
  }
  res.json({ securityScore: security.data, coverageScore: coverage.data });
}));

router.get('/findings', asyncRoute(async (req, res) => {
  const result = await callBci(req.user, '/api/v1/findings');
  if (!result.ok) return res.status(503).json({ error: 'bci_unavailable' });
  res.json(result.data);
}));

router.get('/findings/:id', asyncRoute(async (req, res) => {
  const result = await callBci(req.user, `/api/v1/findings/${encodeURIComponent(req.params.id)}`);
  if (!result.ok) {
    return res.status(result.status === 404 ? 404 : 503).json({ error: 'bci_unavailable' });
  }
  res.json(result.data);
}));

// Shared by both AI advisor routes below -- fetches the one real job +
// engine-run + finding evidence set either advisor reasons over. Returns
// null (having already written the appropriate error response) on any
// BCI-outage/invalid-response case, so callers can just `if (!evidence)
// return;` rather than repeating the same three checks twice.
async function fetchScanEvidence(req, res) {
  const encodedId = encodeURIComponent(req.params.id);
  const [jobResult, runsResult] = await Promise.all([
    callBci(req.user, `/api/v1/scans/${encodedId}`),
    callBci(req.user, `/api/v1/scans/${encodedId}/engine-runs`),
  ]);
  if (!jobResult.ok || !runsResult.ok) {
    res.status(503).json({ error: 'bci_unavailable' });
    return null;
  }
  const job = jobResult.data?.job;
  if (!job) {
    res.status(502).json({ error: 'invalid_bci_response' });
    return null;
  }
  const findingIds = Array.isArray(job?.result?.findingIds) ? job.result.findingIds.slice(0, 20) : [];
  const findingResults = await Promise.all(findingIds.map((id) => callBci(req.user, `/api/v1/findings/${encodeURIComponent(id)}`)));
  const findings = findingResults
    .filter((result) => result.ok && result.data?.finding)
    .map((result) => ({
      ...result.data.finding,
      sources: Array.isArray(result.data.sources) ? result.data.sources : [],
    }));
  return { job, engineRuns: runsResult.data?.engineRuns || [], findings };
}

function parseClassification(req, res) {
  const classification = typeof req.body?.dataClassification === 'string'
    ? req.body.dataClassification.toUpperCase()
    : 'INTERNAL';
  if (!['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'SECRET'].includes(classification)) {
    res.status(400).json({ error: 'invalid_data_classification' });
    return null;
  }
  // SECRET evidence is never eligible for provider egress. Reuse the
  // established RESTRICTED policy to force the local deterministic summary.
  return classification === 'SECRET' ? 'RESTRICTED' : classification;
}

function parseLanguage(req) {
  const language = typeof req.body?.language === 'string' ? req.body.language.toLowerCase() : 'tr';
  return ['tr', 'en', 'de', 'fr', 'ar'].includes(language) ? language : 'tr';
}

// Evidence-bound BCI AI advisor. Scanner output remains authoritative; the
// main application's configured AI provider only explains the immutable job,
// engine-run and finding facts returned by BCI. Provider failure falls back
// to a deterministic explanation inside assessBciScan().
router.post('/assistant/scans/:id', asyncRoute(async (req, res) => {
  const classification = parseClassification(req, res);
  if (!classification) return;
  const evidence = await fetchScanEvidence(req, res);
  if (!evidence) return;
  res.json(await assessBciScan({ ...evidence, dataClassification: classification, language: parseLanguage(req) }));
}));

// BCI Smart Fuzz strategy advisor (real evidence -> a real, bounded
// AI_ADAPTIVE follow-up proposal from BCI's own catalog, layered ON TOP OF
// BCI's own always-run BASE fuzz plan -- see bciFuzzAdvisor.ts). Advisory
// only: the response is a proposal for the caller to review, optionally
// edit, and pass back to BCI as `engineOptions['http-fuzz'].adaptivePlan`
// on a new scan -- this route never itself creates a scan or executes
// anything, and BASE coverage runs in full whether or not this is used.
router.post('/assistant/scans/:id/fuzz-strategy', asyncRoute(async (req, res) => {
  const classification = parseClassification(req, res);
  if (!classification) return;
  const [evidence, catalogResult] = await Promise.all([
    fetchScanEvidence(req, res),
    callBci(req.user, '/api/v1/engines/fuzz-catalog'),
  ]);
  if (!evidence) return;
  if (!catalogResult.ok) return res.status(503).json({ error: 'bci_unavailable' });
  const availableCategoryIds = (catalogResult.data?.categories || []).map((category) => category.id);
  res.json(await proposeFuzzStrategy({ ...evidence, availableCategoryIds, dataClassification: classification, language: parseLanguage(req) }));
}));

// BCI Smart Intrusive strategy advisor. The real, CURRENT set of
// IMPLEMENTED validation module ids is fetched live from BCI itself
// (never a hardcoded/driftable copy in this file) so the AI is only ever
// offered modules BCI can actually execute today. Advisory only: the
// response is a proposal for the caller to review, optionally edit, and
// pass back as `engineOptions['intrusive-validation'].adaptivePlan` on a
// new scan -- this route never itself creates a scan or executes
// anything, and BCI's own BASE module selection runs in full regardless.
router.post('/assistant/scans/:id/intrusive-strategy', asyncRoute(async (req, res) => {
  const classification = parseClassification(req, res);
  if (!classification) return;
  const [evidence, modulesResult] = await Promise.all([
    fetchScanEvidence(req, res),
    callBci(req.user, '/api/v1/engines/intrusive-modules'),
  ]);
  if (!evidence) return;
  if (!modulesResult.ok) return res.status(503).json({ error: 'bci_unavailable' });
  const implementedModuleIds = (modulesResult.data?.modules || [])
    .filter((m) => m.status === 'IMPLEMENTED')
    .map((m) => m.id);
  res.json(await proposeIntrusiveStrategy({ ...evidence, implementedModuleIds, dataClassification: classification, language: parseLanguage(req) }));
}));

// BCI Smart Resilience strategy advisor. Same live-module-list pattern as
// the intrusive-strategy route above. Advisory only: the response is a
// proposal for the caller to review, optionally edit, and pass back as
// `engineOptions['availability-probe'].adaptivePlan` on a new scan -- this
// route never itself creates a scan or generates any real load; execution
// always happens in bci/src/engines/resilience/loadEngine.js, and BCI's
// own BASE module selection (plus the user's own requestedPlan) runs in
// full regardless of this proposal.
router.post('/assistant/scans/:id/resilience-strategy', asyncRoute(async (req, res) => {
  const classification = parseClassification(req, res);
  if (!classification) return;
  const [evidence, modulesResult] = await Promise.all([
    fetchScanEvidence(req, res),
    callBci(req.user, '/api/v1/engines/resilience-modules'),
  ]);
  if (!evidence) return;
  if (!modulesResult.ok) return res.status(503).json({ error: 'bci_unavailable' });
  const implementedModuleIds = (modulesResult.data?.modules || [])
    .filter((m) => m.status === 'IMPLEMENTED')
    .map((m) => m.id);
  res.json(await proposeResilienceStrategy({ ...evidence, implementedModuleIds, dataClassification: classification, language: parseLanguage(req) }));
}));

// Generic passthrough for the rest of BCI's API surface (assets, scopes,
// scans, reports, engines, quantum, crypto) -- hand-writing a proxy route
// per BCI endpoint here would just re-describe BCI's own route table.
// BCI still independently enforces its own fine-grained RBAC
// (requirePermission(...) on every one of these paths on BCI's side); this
// only adds the ADMIN/ANALYST gate above (router.use, already applied) and
// the same never-throws BCI-outage degradation as every other route here.
router.all('/proxy/*', asyncRoute(async (req, res) => {
  // req.params[0] is only the wildcard path segment -- Express never
  // includes the query string in it, so a GET with real query params
  // (e.g. /engines/plan?targetType=...&requestedClass=...) silently lost
  // them here, and BCI's own zod schema then rejected the request as
  // missing required fields it was, in fact, sent. Rebuilding it from
  // req.query (already parsed) forwards it exactly, regardless of how
  // many params or what shape.
  const queryString = new URLSearchParams(req.query).toString();
  const bciPath = `/api/v1/${req.params[0]}${queryString ? `?${queryString}` : ''}`;
  const timeoutMs = req.params[0] === 'controlled-proof/analyze'
    ? CONTROLLED_PROOF_ANALYZE_TIMEOUT_MS
    : undefined;
  const result = await callBci(req.user, bciPath, {
    method: req.method,
    body: ['POST', 'PATCH', 'PUT'].includes(req.method) ? req.body : undefined,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  if (!result.ok) {
    if (result.reason === 'bci_error') {
      return res.status(result.status || 503).json(result.data || { error: 'bci_error' });
    }
    return res.status(503).json({ error: 'bci_unavailable' });
  }
  res.json(result.data);
}));

export default router;
