import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../lib/rbac.js';
import { query } from '../db/client.js';
import { enqueueScan, getJob, listJobs, cancelJob, archiveJob, unarchiveJob, deleteJob } from '../services/jobQueue.js';
import { FUZZ_CATEGORY_IDS } from '../engines/adapters/fuzzCatalog.js';
import { getIntrusiveModule, selectApplicableModules } from '../engines/intrusive/registry.js';
import { loadCanonicalPriorFindings } from '../services/intrusivePlanning.js';
import { discoverEndpoints } from '../engines/adapters/fuzzDiscovery.js';
import { assertHttpTarget } from '../engines/adapters/nativeHttp.js';
import { resolveAuthProfile, resolveFuzzBaseScope, resolveNaabuScope, resolveNucleiScope } from '../engines/executionProfiles.js';
import { postureSnapshotSchema, redactSnapshotValue } from '../engines/adapters/postureIntelligence.js';
import { normalizeTargetForExecution } from '../lib/targetMatcher.js';
import { recordAuditEvent } from '../services/audit.js';
import { loadPentestContext } from '../services/pentest.js';
import { withPentestTransport } from '../pentest/transport.js';

export const scansRouter = Router();

scansRouter.use(requireAuth);

const requestCountModeSchema = z.enum(['100', '500', '1000', '5000', '10000', 'CUSTOM', 'UNLIMITED']);
const fixedRequestCounts = { 100: 100, 500: 500, 1000: 1000, 5000: 5000, 10000: 10_000 };
const resilienceRequestedPlanSchema = z.object({
  requestCountMode: requestCountModeSchema,
  totalRequests: z.number().int().positive().nullable(),
  concurrency: z.number().int().positive(),
  targetRps: z.number().positive(),
  durationMs: z.number().int().positive().nullable(),
  rampUpMs: z.number().int().nonnegative(),
  rampDownMs: z.number().int().nonnegative(),
  requestTimeoutMs: z.number().int().positive(),
  recoveryObservationMs: z.number().int().nonnegative(),
  profile: z.enum(['constant', 'ramp_up', 'ramp_down', 'step', 'spike', 'burst', 'sustained']),
}).partial().superRefine((plan, ctx) => {
  const fixedCount = fixedRequestCounts[plan.requestCountMode];
  if (fixedCount && plan.totalRequests != null && plan.totalRequests !== fixedCount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['totalRequests'], message: `${plan.requestCountMode} requires totalRequests=${fixedCount}` });
  }
  if (plan.requestCountMode === 'CUSTOM' && plan.totalRequests == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['totalRequests'], message: 'CUSTOM requires totalRequests' });
  }
  if (plan.requestCountMode === 'UNLIMITED' && plan.totalRequests != null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['totalRequests'], message: 'UNLIMITED cannot set totalRequests' });
  }
  if (plan.durationMs != null && (plan.rampUpMs ?? 0) + (plan.rampDownMs ?? 0) > plan.durationMs) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rampUpMs'], message: 'ramp windows cannot exceed durationMs' });
  }
});

const createScanSchema = z.object({
  target: z.string().min(1),
  requestedClass: z.enum(['PASSIVE', 'SAFE_ACTIVE', 'AUTHENTICATED', 'RESTRICTED']),
  // Real per-job engine selection (spec: BCI recommends, the caller
  // chooses among compatible healthy engines, selected engines actually
  // run) -- the BCI recommendation remains separate advisory provenance.
  // Omitted entirely = the full recommended plan, same as before this existed.
  selectedEngineIds: z.array(z.string().min(1)).optional(),
  selectedCapabilities: z.array(z.string().min(1)).optional(),
  // The wizard's Quantum-step choice, stored for later use once this job's
  // findings exist -- see routes/quantum.js's remediation-optimize, which
  // is where a compute method actually ever executes.
  selectedComputeMode: z.enum(['CLASSICAL', 'QUANTUM_INSPIRED', 'QUANTUM_SIMULATOR', 'QUANTUM_HARDWARE']).optional(),
  // BCI Smart Fuzz's optional externally-proposed AI_ADAPTIVE round (e.g.
  // from BQI's bciFuzzAdvisor.ts) -- layered ON TOP of BCI's own
  // BASE fuzz plan, never a replacement for it (httpFuzzAdapter's BASE
  // plan is built unconditionally, before this is even read). httpFuzz-
  // Adapter's own sanitizeAdaptivePlan() still independently re-validates
  // every entry against its real discovered endpoints/catalog before
  // executing anything; this schema only bounds the SHAPE, never the
  // content. USER has no product cap; AI_ADAPTIVE alone retains the
  // MAX_ADAPTIVE_PROBES=20 budget. No other engine accepts these options.
  // Deliberately excludes any credential/auth field -- engine_options is
  // persisted and returned in API responses.
  // BCI Smart Intrusive's equivalent: userSelectedModuleIds is an ADMIN's
  // (scan:create + the RESTRICTED-class scope approval every intrusive-
  // validation run already requires -- no separate/second approval gate
  // added here) explicit choice, always executed, never filtered by AI.
  // adaptivePlan mirrors Smart Fuzz's -- an AI-proposed addition,
  // validated against the real module registry before executing anything
  // (intrusiveValidationAdapter's own execute() re-checks regardless of
  // what this schema allows). priorFindings feeds
  // FINDING_REPRODUCIBILITY_VERIFICATION -- capped, and this column is
  // persisted/returned like any other engineOptions entry, so it's meant
  // for real finding summaries, not arbitrary large payloads.
  engineOptions: z.object({
    'http-fuzz': z.object({
      engagementId: z.string().uuid(),
      baseProfile: z.enum(['STANDARD', 'EXTENDED', 'FULL', 'CUSTOM']),
      customMaxParameters: z.number().int().positive(),
      authProfileId: z.string().regex(/^[A-Za-z0-9_]{1,40}$/),
      userPlan: z.array(z.object({
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH']),
        url: z.string().url(),
        parameter: z.string().min(1),
        location: z.enum(['query', 'header', 'body']),
        categoryId: z.string().refine((id) => FUZZ_CATEGORY_IDS.includes(id), 'unknown fuzz category'),
      })),
      adaptivePlan: z.array(z.object({
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH']),
        url: z.string().min(1),
        parameter: z.string().min(1),
        location: z.enum(['query', 'header', 'body']),
        categoryId: z.string().min(1),
      })).max(20),
    }).partial().optional(),
    nuclei: z.object({
      scanProfile: z.enum(['BCI_BUNDLED', 'STANDARD', 'EXTENDED', 'FULL_SAFE']),
      templateCategories: z.array(z.enum(['CVE', 'MISCONFIGURATION', 'EXPOSURE', 'VULNERABILITY', 'TECHNOLOGY', 'API'])),
      rateLimit: z.number().int().positive(),
    }).partial().optional(),
    naabu: z.object({
      portProfile: z.enum(['TOP_PORTS', 'PORTS_1_1000', 'FULL_PORTS', 'CUSTOM']),
      customPorts: z.string().min(1).max(1000),
      rateLimit: z.number().int().positive(),
    }).partial().optional(),
    semgrep: z.object({ config: z.enum(['auto', 'p/default', 'p/security-audit', 'p/owasp-top-ten']) }).partial().optional(),
    'intrusive-validation': z.object({
      engagementId: z.string().uuid(),
      authProfileId: z.string().regex(/^[A-Za-z0-9_]{1,40}$/),
      userSelectedModuleIds: z.array(z.string().min(1)).max(20),
      adaptivePlan: z.array(z.object({
        moduleId: z.string().min(1),
        rationale: z.string().max(500).optional(),
      })).max(20),
      priorFindings: z.array(z.object({
        id: z.string().min(1),
        title: z.string().optional(),
        location: z.string().optional(),
        evidence: z.record(z.string(), z.any()).optional(),
      })).max(20),
    }).partial().optional(),
    // BCI Smart Resilience's equivalent (bci/src/engines/resilience/).
    // requestedPlan is the user's real load parameters -- validated and
    // honored without product-level maxima. Both requested and executed
    // plans are recorded on every round. endpoints/
    // priorFindings enable MULTI_ENDPOINT/CROSS_ENGINE_TARGETED_RESILIENCE
    // the same way http-fuzz/intrusive-validation's do. Deliberately no
    // credential field here either.
    'availability-probe': z.object({
      requestedPlan: resilienceRequestedPlanSchema,
      userSelectedModuleIds: z.array(z.string().min(1)).max(20),
      adaptivePlan: z.array(z.object({
        moduleId: z.string().min(1),
        requestedPlan: resilienceRequestedPlanSchema.optional(),
        rationale: z.string().max(500).optional(),
      })).max(10),
      endpoints: z.array(z.string().min(1)).max(20),
      priorFindings: z.array(z.object({
        id: z.string().min(1),
        title: z.string().optional(),
        location: z.string().optional(),
        evidence: z.record(z.string(), z.any()).optional(),
      })).max(20),
    }).partial().optional(),
    'bci-posture-intelligence': z.object({
      snapshot: postureSnapshotSchema,
    }).optional(),
  }).partial().optional(),
});

// This is the one place a scan actually starts. Scope is not checked --
// enqueueScan() can still reject a request over its selectedEngineIds
// (empty, incompatible, or unhealthy), which is what accepted:false means
// here now.
scansRouter.post('/', requirePermission('scan:create'), async (req, res) => {
  const parsed = createScanSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten(), requestId: req.id });
  }
  const normalizedScanTarget = normalizeTargetForExecution(parsed.data.target);
  const pentestContexts = {};
  try {
    for (const engineId of ['http-fuzz', 'intrusive-validation']) {
      const id = parsed.data.engineOptions?.[engineId]?.engagementId;
      if (id) {
        if (parsed.data.requestedClass !== 'RESTRICTED') throw new Error('pentest engagement requires RESTRICTED execution class');
        pentestContexts[engineId] = await loadPentestContext(req.auth.orgId, id, normalizedScanTarget);
      }
    }
  } catch { return res.status(400).json({ error: 'invalid_pentest_execution' }); }

  try {
    const fuzz = parsed.data.engineOptions?.['http-fuzz'];
    if (fuzz) {
      resolveFuzzBaseScope(fuzz.baseProfile, fuzz.customMaxParameters);
      resolveAuthProfile(fuzz.authProfileId, { orgId: req.auth.orgId, target: normalizedScanTarget });
    }
    const nuclei = parsed.data.engineOptions?.nuclei;
    if (nuclei) resolveNucleiScope(nuclei.scanProfile, nuclei.templateCategories);
    const naabu = parsed.data.engineOptions?.naabu;
    if (naabu) resolveNaabuScope(naabu.portProfile, naabu.customPorts);
  } catch (err) {
    return res.status(400).json({ error: 'invalid_execution_scope', detail: String(err.message || err), requestId: req.id });
  }

  const intrusiveOptions = parsed.data.engineOptions?.['intrusive-validation'];
  if (intrusiveOptions) {
    const requestedPriorFindings = intrusiveOptions.priorFindings || [];
    const canonicalPriorFindings = await loadCanonicalPriorFindings(
      req.auth.orgId, normalizedScanTarget, requestedPriorFindings.map((finding) => finding.id)
    );
    if (canonicalPriorFindings.length !== requestedPriorFindings.length) {
      return res.status(400).json({ error: 'invalid_prior_findings', requestId: req.id });
    }
    const normalizedTarget = /^https?:\/\//i.test(normalizedScanTarget) ? normalizedScanTarget : `https://${normalizedScanTarget}`;
    let discovery = {};
    try {
      const auth = resolveAuthProfile(intrusiveOptions.authProfileId, { orgId: req.auth.orgId, target: normalizedTarget });
      const requestedModuleIds = [
        ...(intrusiveOptions.userSelectedModuleIds || []),
        ...(intrusiveOptions.adaptivePlan || []).map((entry) => entry.moduleId),
      ];
      if (requestedModuleIds.includes('OPENAPI_SCHEMA_BEHAVIOR')) {
        const discover = () => discoverEndpoints(assertHttpTarget(normalizedTarget), { headers: auth.headers });
        const transport = pentestContexts['intrusive-validation'] || (auth.profileId ? { engagement: { target: normalizedTarget, environment: 'PRODUCTION' } } : null);
        discovery = transport ? await withPentestTransport(transport, undefined, discover) : await discover();
      }
    } catch (err) {
      return res.status(400).json({ error: 'intrusive_preflight_failed', detail: String(err.message || err), requestId: req.id });
    }
    const applicableIds = new Set(selectApplicableModules({ target: normalizedTarget, priorFindings: canonicalPriorFindings, pentestContext: pentestContexts['intrusive-validation'], ...discovery }).map((module) => module.id));
    for (const [source, ids] of [
      ['USER', intrusiveOptions.userSelectedModuleIds || []],
      ['AI_ADAPTIVE', (intrusiveOptions.adaptivePlan || []).map((entry) => entry.moduleId)],
    ]) {
      for (const id of ids) {
        const module = getIntrusiveModule(id);
        if (!module) return res.status(400).json({ error: 'unknown_intrusive_module', moduleId: id, source, requestId: req.id });
        if (module.status !== 'IMPLEMENTED') return res.status(400).json({ error: 'intrusive_module_not_implemented', moduleId: id, source, requestId: req.id });
        if (!applicableIds.has(id)) return res.status(400).json({ error: 'intrusive_module_not_applicable', moduleId: id, source, requestId: req.id });
      }
    }
    intrusiveOptions.priorFindings = canonicalPriorFindings;
  }

  const postureOptions = parsed.data.engineOptions?.['bci-posture-intelligence'];
  if (postureOptions) {
    // engine_options is persisted before the worker executes. Redact at
    // this trust boundary so credentials never land in scan_jobs even for
    // a job that is cancelled or fails before adapter execution.
    postureOptions.snapshot = redactSnapshotValue(postureOptions.snapshot);
  }

  const outcome = await enqueueScan({
    orgId: req.auth.orgId,
    actorUserId: req.auth.userId,
    target: normalizedScanTarget,
    requestedClass: parsed.data.requestedClass,
    selectedEngineIds: parsed.data.selectedEngineIds,
    selectedCapabilities: parsed.data.selectedCapabilities,
    selectedComputeMode: parsed.data.selectedComputeMode,
    engineOptions: parsed.data.engineOptions,
  });

  if (!outcome.accepted) {
    await recordAuditEvent({
      orgId: req.auth.orgId,
      actorUserId: req.auth.userId,
      action: 'scan.create_rejected',
      targetType: 'scan_job',
      targetId: normalizedScanTarget,
      result: 'DENY',
      metadata: { requestedClass: parsed.data.requestedClass, reason: outcome.decision.reason },
    });
    return res.status(403).json({ error: 'scan_rejected', reason: outcome.decision.reason, requestId: req.id, ...outcome.decision });
  }

  res.status(201).json({ job: outcome.job });
});

scansRouter.get('/', requirePermission('scan:view'), async (req, res) => {
  res.json({ jobs: await listJobs(req.auth.orgId, { archivedOnly: req.query.archived === 'true' }) });
});

scansRouter.get('/:id', requirePermission('scan:view'), async (req, res) => {
  const job = await getJob(req.auth.orgId, req.params.id);
  if (!job) return res.status(404).json({ error: 'job_not_found', requestId: req.id });
  res.json({ job });
});

// Findings are linked to a scan through their immutable normalized evidence
// sources, never by target string. This keeps repeated analyses of the same
// URL separate while still allowing one correlated Finding to be observed by
// more than one scan without duplicating the Finding itself.
scansRouter.get('/:id/findings', requirePermission('scan:view'), async (req, res) => {
  const job = await getJob(req.auth.orgId, req.params.id);
  if (!job) return res.status(404).json({ error: 'job_not_found', requestId: req.id });

  const { rows } = await query(
    `SELECT DISTINCT f.id, f.category, f.title, f.cve_ids, f.cwe_ids, f.component,
            f.component_version, f.location, f.target, f.status, f.verification_status,
            f.confidence_score, f.risk_score, f.priority, f.created_at, f.updated_at
       FROM findings f
       JOIN finding_sources fs ON fs.finding_id = f.id
       JOIN normalized_observations no ON no.id = fs.normalized_observation_id
      WHERE f.org_id = $1 AND no.org_id = $1 AND no.job_id = $2
      ORDER BY f.created_at DESC`,
    [req.auth.orgId, req.params.id]
  );
  res.json({ findings: rows });
});

// Real per-engine execution status for a job (spec: "Motor Çalışma
// Durumu") -- straight from scan_job_engine_runs, the same table
// analysisPipeline.js writes to as each planned engine finishes. Never a
// derived/fake progress percentage: only what's actually been recorded.
scansRouter.get('/:id/engine-runs', requirePermission('scan:view'), async (req, res) => {
  const job = await getJob(req.auth.orgId, req.params.id);
  if (!job) return res.status(404).json({ error: 'job_not_found', requestId: req.id });

  const { rows } = await query(
    `SELECT engine_id, status, detail, observation_count, started_at, finished_at
       FROM scan_job_engine_runs WHERE job_id = $1 ORDER BY started_at`,
    [req.params.id]
  );
  res.json({ engineRuns: rows });
});

// Completed Smart Resilience rounds, directly from the immutable raw
// observation written by the engine. This endpoint deliberately exposes no
// fabricated in-flight counters: before the engine persists a measurement it
// returns an empty list and the Wizard says live data is not available yet.
scansRouter.get('/:id/resilience-rounds', requirePermission('scan:view'), async (req, res) => {
  const job = await getJob(req.auth.orgId, req.params.id);
  if (!job) return res.status(404).json({ error: 'job_not_found', requestId: req.id });
  const { rows } = await query(
    `SELECT payload FROM raw_observations
       WHERE org_id = $1 AND job_id = $2 AND engine_id = 'availability-probe'
       ORDER BY created_at`,
    [req.auth.orgId, req.params.id]
  );
  const rounds = rows.flatMap(({ payload }) => Array.isArray(payload?.raw) ? payload.raw : []);
  res.json({ rounds });
});

scansRouter.get('/:id/fuzz-results', requirePermission('scan:view'), async (req, res) => {
  const job = await getJob(req.auth.orgId, req.params.id);
  if (!job) return res.status(404).json({ error: 'job_not_found', requestId: req.id });
  const { rows } = await query(
    `SELECT payload FROM raw_observations
       WHERE org_id = $1 AND job_id = $2 AND engine_id = 'http-fuzz'
       ORDER BY created_at`,
    [req.auth.orgId, req.params.id]
  );
  const executions = rows.map(({ payload }) => ({
    probes: Array.isArray(payload?.raw) ? payload.raw : [],
    discoveryMeta: payload?.discoveryMeta ?? null,
  }));
  res.json({ executions });
});

scansRouter.get('/:id/intrusive-results', requirePermission('scan:view'), async (req, res) => {
  const job = await getJob(req.auth.orgId, req.params.id);
  if (!job) return res.status(404).json({ error: 'job_not_found', requestId: req.id });
  const { rows } = await query(
    `SELECT payload FROM raw_observations
       WHERE org_id = $1 AND job_id = $2 AND engine_id = 'intrusive-validation'
       ORDER BY created_at`,
    [req.auth.orgId, req.params.id]
  );
  const executions = rows.map(({ payload }) => ({
    records: Array.isArray(payload?.raw) ? payload.raw : [],
    moduleMeta: payload?.moduleMeta ?? null,
  }));
  res.json({ executions });
});

scansRouter.post('/:id/cancel', requirePermission('scan:cancel'), async (req, res) => {
  const job = await cancelJob({ orgId: req.auth.orgId, actorUserId: req.auth.userId, jobId: req.params.id });
  if (!job) {
    return res.status(404).json({ error: 'job_not_found_or_already_terminal', requestId: req.id });
  }
  res.json({ job });
});

// Archiving only changes visibility (which list a job shows up in) -- it
// never touches status/execution, so it's gated at the same permission as
// cancel rather than a new, narrower one (spec: anyone who can stop a scan
// can also put it away). Available regardless of the job's status.
scansRouter.post('/:id/archive', requirePermission('scan:cancel'), async (req, res) => {
  const job = await archiveJob({ orgId: req.auth.orgId, actorUserId: req.auth.userId, jobId: req.params.id });
  if (!job) return res.status(404).json({ error: 'job_not_found_or_already_archived', requestId: req.id });
  res.json({ job });
});

scansRouter.post('/:id/unarchive', requirePermission('scan:cancel'), async (req, res) => {
  const job = await unarchiveJob({ orgId: req.auth.orgId, actorUserId: req.auth.userId, jobId: req.params.id });
  if (!job) return res.status(404).json({ error: 'job_not_found_or_not_archived', requestId: req.id });
  res.json({ job });
});

scansRouter.delete('/:id', requirePermission('scan:cancel'), async (req, res) => {
  const job = await deleteJob({ orgId: req.auth.orgId, actorUserId: req.auth.userId, jobId: req.params.id });
  if (!job) return res.status(409).json({ error: 'job_not_found_or_not_terminal', requestId: req.id });
  res.json({ job });
});
