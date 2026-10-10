import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../lib/rbac.js';
import { getEngineStatus, getEngineCatalog, getCapabilityCatalog, runHealthChecks } from '../engines/registry.js';
import { planEngines, candidateEnginesForTargetType, availableCapabilitiesForTargetType } from '../services/analysisPlanner.js';
import { recordAuditEvent } from '../services/audit.js';
import { config } from '../config.js';
import { listIntrusiveModules } from '../engines/intrusive/registry.js';
import { buildIntrusivePlan, loadCanonicalPriorFindings, loadTargetFindings } from '../services/intrusivePlanning.js';
import { listResilienceModules } from '../engines/resilience/registry.js';
import { LOAD_PLAN_CAPABILITIES } from '../engines/resilience/loadEngine.js';
import { FUZZ_CATEGORIES, BASE_MIN_TESTS_PER_PARAMETER, defaultCategoriesFor } from '../engines/adapters/fuzzCatalog.js';
import { buildBasePlan, MAX_BASE_PARAMETERS, MAX_ADAPTIVE_PROBES } from '../engines/adapters/httpFuzz.js';
import { discoverEndpoints } from '../engines/adapters/fuzzDiscovery.js';
import { assertHttpTarget } from '../engines/adapters/nativeHttp.js';
import { resolveAuthProfile, resolveFuzzBaseScope } from '../engines/executionProfiles.js';
import { loadPentestContext } from '../services/pentest.js';
import { withPentestTransport } from '../pentest/transport.js';
import { controlledFuzzEndpoints } from '../pentest/fuzz.js';

export const enginesRouter = Router();
enginesRouter.use(requireAuth);

enginesRouter.get('/', requirePermission('rule:view'), async (_req, res) => {
  res.json({ engines: await getEngineStatus(), capabilities: getCapabilityCatalog() });
});

// Registry-backed capability catalog. The UI must consume this endpoint
// rather than maintain a second hard-coded list.
enginesRouter.get('/capabilities', requirePermission('rule:view'), (_req, res) => {
  res.json({ capabilities: getCapabilityCatalog() });
});

// BCI Smart Intrusive's Dynamic Intrusive Validation Registry, exposed for
// transparency (spec: never claim a module ran when it didn't) -- every
// registered module (including PLANNED, real-but-not-yet-executed ones)
// with its real status, never a hidden or hard-coded list a caller has to
// guess at. Never includes run()/isApplicable() function bodies -- only
// the real, JSON-safe metadata.
enginesRouter.get('/intrusive-modules', requirePermission('rule:view'), (_req, res) => {
  res.json({
    modules: listIntrusiveModules().map(({ id, family, name, description, status, requiredIntrusiveness, blockedOn }) => ({
      id, family, name, description, status, requiredIntrusiveness, blockedOn: blockedOn ?? null,
    })),
  });
});

// BCI Smart Resilience's Dynamic Resilience Registry, exposed the same
// way (spec: never claim a module ran when it didn't). loadPlanCapabilities
// is the canonical Wizard/API catalog; product-level maxima are deliberately
// absent and runtime failures are reported by the executing round.
enginesRouter.get('/resilience-modules', requirePermission('rule:view'), (_req, res) => {
  res.json({
    modules: listResilienceModules().map(({ id, family, name, description, status, requiredIntrusiveness, blockedOn }) => ({
      id, family, name, description, status, requiredIntrusiveness, blockedOn: blockedOn ?? null,
    })),
    loadPlanCapabilities: LOAD_PLAN_CAPABILITIES,
  });
});

enginesRouter.get('/fuzz-catalog', requirePermission('rule:view'), (_req, res) => {
  res.json({
    categories: FUZZ_CATEGORIES.map(({ id, appliesTo, reflectionMarker }) => ({
      id, appliesTo, detectsReflection: !!reflectionMarker,
    })),
    baseMinTestsPerParameter: BASE_MIN_TESTS_PER_PARAMETER,
    maxBaseParameters: null,
    standardMaxBaseParameters: MAX_BASE_PARAMETERS,
    baseProfiles: ['STANDARD', 'EXTENDED', 'FULL', 'CUSTOM'],
    maxUserProbes: null,
    maxAdaptiveProbes: MAX_ADAPTIVE_PROBES,
    defaultCategoryIdsByType: {
      string: defaultCategoriesFor('string'), integer: defaultCategoriesFor('integer'), generic: defaultCategoriesFor('generic'),
    },
  });
});

const intrusivePlanSchema = z.object({
  engagementId: z.string().uuid().optional(),
  target: z.string().min(1),
  priorFindingIds: z.array(z.string().uuid()).max(50).default([]),
  authProfileId: z.string().regex(/^[A-Za-z0-9_]{1,40}$/).optional(),
});

// Target/evidence-specific view of the dynamic registry. Finding summaries
// and applicability are derived from BCI's persisted pipeline data, never
// invented by the client.
enginesRouter.post('/intrusive-plan', requirePermission('scan:create'), async (req, res) => {
  const parsed = intrusivePlanSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request', requestId: req.id });
  const findings = await loadTargetFindings(req.auth.orgId, parsed.data.target);
  const selectedFindings = await loadCanonicalPriorFindings(req.auth.orgId, parsed.data.target, parsed.data.priorFindingIds);
  if (selectedFindings.length !== parsed.data.priorFindingIds.length) {
    return res.status(400).json({ error: 'invalid_prior_findings', requestId: req.id });
  }
  const normalizedTarget = /^https?:\/\//i.test(parsed.data.target) ? parsed.data.target : `https://${parsed.data.target}`;
  let discovery = {};
  let pentestContext;
  try {
    if (parsed.data.engagementId) pentestContext = await loadPentestContext(req.auth.orgId, parsed.data.engagementId, normalizedTarget);
    const auth = resolveAuthProfile(parsed.data.authProfileId, { orgId: req.auth.orgId, target: normalizedTarget });
    const discover = () => discoverEndpoints(assertHttpTarget(normalizedTarget), { headers: auth.headers });
    const transport = pentestContext || (auth.profileId ? { engagement: { target: normalizedTarget, environment: 'PRODUCTION' } } : null);
    discovery = transport ? await withPentestTransport(transport, undefined, discover) : await discover();
  } catch (err) {
    if (parsed.data.engagementId) return res.status(400).json({ error: 'invalid_pentest_engagement' });
    if (parsed.data.authProfileId) return res.status(400).json({ error: 'invalid_auth_profile', detail: String(err.message || err), requestId: req.id });
  }
  res.json({ ...buildIntrusivePlan(normalizedTarget, selectedFindings, { ...discovery, pentestContext }), findings });
});

const fuzzDiscoverySchema = z.object({
  engagementId: z.string().uuid().optional(),
  target: z.string().min(1),
  targetType: z.enum(['DOMAIN', 'SUBDOMAIN', 'URL', 'API']).optional(),
  baseProfile: z.enum(['STANDARD', 'EXTENDED', 'FULL', 'CUSTOM']).default('STANDARD'),
  customMaxParameters: z.number().int().positive().optional(),
  authProfileId: z.string().regex(/^[A-Za-z0-9_]{1,40}$/).optional(),
});

enginesRouter.post('/fuzz-discovery', requirePermission('scan:create'), async (req, res) => {
  const parsed = fuzzDiscoverySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten(), requestId: req.id });
  const normalizedTarget = ['DOMAIN', 'SUBDOMAIN'].includes(parsed.data.targetType)
    ? `https://${parsed.data.target}` : parsed.data.target;
  let target;
  try { target = assertHttpTarget(normalizedTarget); } catch (err) {
    return res.status(400).json({ error: 'invalid_target', detail: String(err.message || err), requestId: req.id });
  }
  let authProfile;
  let baseScope;
  try {
    authProfile = resolveAuthProfile(parsed.data.authProfileId, { orgId: req.auth.orgId, target });
    baseScope = resolveFuzzBaseScope(parsed.data.baseProfile, parsed.data.customMaxParameters);
  } catch (err) {
    return res.status(400).json({ error: 'invalid_execution_scope', detail: String(err.message || err), requestId: req.id });
  }
  let pentestContext;
  try { if (parsed.data.engagementId) pentestContext = await loadPentestContext(req.auth.orgId, parsed.data.engagementId, target); }
  catch { return res.status(400).json({ error: 'invalid_pentest_engagement' }); }
  const discover = () => discoverEndpoints(target, { headers: authProfile.headers });
  const transport = pentestContext || (authProfile.profileId ? { engagement: { target, environment: 'PRODUCTION' } } : null);
  const discovery = transport ? await withPentestTransport(transport, undefined, discover) : await discover();
  const endpoints = [...discovery.endpoints, ...controlledFuzzEndpoints(pentestContext)];
  const { openapiSource } = discovery;
  const basePlan = buildBasePlan(endpoints, baseScope);
  res.json({
    target, endpoints, openapiSource,
    summary: {
      endpoints: endpoints.length,
      parameters: endpoints.reduce((sum, endpoint) => sum + endpoint.params.length, 0),
      getEndpoints: endpoints.filter((endpoint) => endpoint.method === 'GET').length,
      mutatingEndpoints: endpoints.filter((endpoint) => endpoint.method !== 'GET').length,
      baseProbes: basePlan.length,
      baseProfile: baseScope.baseProfile,
      maxParameters: baseScope.maxParameters,
      authProfileId: authProfile.profileId,
    },
  });
});

const planQuerySchema = z.object({
  targetType: z.string().min(1),
  requestedClass: z.enum(['PASSIVE', 'SAFE_ACTIVE', 'AUTHENTICATED', 'RESTRICTED']),
  capability: z.string().min(1).optional(),
  capabilities: z.string().optional(),
});

enginesRouter.get('/plan', requirePermission('rule:view'), async (req, res) => {
  const parsed = planQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten(), requestId: req.id });
  }
  const { targetType, requestedClass, capability, capabilities } = parsed.data;
  const selectedCapabilities = [...new Set((capabilities ? capabilities.split(',') : capability ? [capability] : []).filter(Boolean).map((id) => id.toUpperCase()))];
  const capabilityCatalog = getCapabilityCatalog();
  const unknownCapabilities = selectedCapabilities.filter((id) => !capabilityCatalog.some((c) => c.id === id));
  if (unknownCapabilities.length > 0) {
    return res.status(400).json({ error: 'unknown_capability', capabilities: unknownCapabilities, requestId: req.id });
  }

  const catalog = await getEngineCatalog();
  const targetIds = new Set(candidateEnginesForTargetType(targetType).map((p) => p.engineId));
  const targetCapabilitiesById = new Map(candidateEnginesForTargetType(targetType).map((plan) => [plan.engineId, plan.capabilities]));
  const plannedIds = new Set(planEngines(targetType, requestedClass, selectedCapabilities).map((p) => p.engineId));
  const engines = catalog.map((e) => {
    const targetCompatible = targetIds.has(e.id);
    const intrusivenessCompatible = targetCompatible && planEngines(targetType, requestedClass).some((p) => p.engineId === e.id);
    const targetCapabilities = targetCapabilitiesById.get(e.id) ?? [];
    const capabilityCompatible = selectedCapabilities.length === 0 || targetCapabilities.some((id) => selectedCapabilities.includes(id));
    const inputReady = e.executionOptions?.requiresSnapshot !== true;
    const compatible = targetCompatible && intrusivenessCompatible && capabilityCompatible;
    const reasons = [];
    if (!targetCompatible) reasons.push('TARGET_TYPE_UNSUPPORTED');
    else if (!intrusivenessCompatible) reasons.push('INTRUSIVENESS_EXCEEDS_REQUEST');
    if (!capabilityCompatible) reasons.push('CAPABILITY_UNSUPPORTED');
    if (e.status !== 'HEALTHY') reasons.push('ENGINE_UNAVAILABLE');
    if (!inputReady) reasons.push('INPUT_REQUIRED');
    const recommended = plannedIds.has(e.id) && inputReady;
    return {
      ...e, targetCapabilities, targetCompatible, intrusivenessCompatible, capabilityCompatible, compatible, inputReady, recommended,
      compatibilityStatus: compatible ? 'COMPATIBLE' : 'INCOMPATIBLE',
      availabilityStatus: e.status === 'HEALTHY' && inputReady ? 'AVAILABLE' : 'UNAVAILABLE',
      decision: !inputReady ? 'INPUT_REQUIRED' : e.status !== 'HEALTHY' ? 'UNAVAILABLE' : recommended ? 'RECOMMENDED' : compatible ? 'COMPATIBLE' : 'INCOMPATIBLE',
      reasons,
    };
  });

  const executableEngineIds = new Set(engines.filter((engine) => engine.status === 'HEALTHY' && engine.inputReady).map((engine) => engine.id));
  const capabilitiesForCurrentInput = availableCapabilitiesForTargetType(targetType, requestedClass, catalog).map((capability) => ({
    ...capability,
    available: capability.available && capability.executableEngineIds.some((engineId) => executableEngineIds.has(engineId)),
    executableEngineIds: capability.executableEngineIds.filter((engineId) => executableEngineIds.has(engineId)),
  }));

  res.json({
    engines,
    capabilities: capabilitiesForCurrentInput,
    selectedCapabilities,
    hasExecutableEngine: engines.some((e) => e.recommended && e.status === 'HEALTHY' && e.inputReady),
  });
});

enginesRouter.post('/health-check', requirePermission('system:manage'), async (req, res) => {
  // Scanner binaries live in the isolated worker in the split production
  // deployment. Probing inside the API image would overwrite truthful worker
  // health with false OFFLINE results. LOCAL mode remains available for a
  // deliberately co-located development/runtime setup.
  const workerManaged = config.engineHealthMode === 'WORKER';
  const results = workerManaged ? await getEngineStatus() : await runHealthChecks();
  await recordAuditEvent({
    orgId: req.auth.orgId,
    actorUserId: req.auth.userId,
    action: 'engines.health_check',
    result: 'SUCCESS',
    metadata: { results, mode: workerManaged ? 'WORKER_SNAPSHOT' : 'LOCAL_EXECUTION' },
  });
  res.json({ results, mode: workerManaged ? 'WORKER_SNAPSHOT' : 'LOCAL_EXECUTION' });
});
