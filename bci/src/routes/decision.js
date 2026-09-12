import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../lib/rbac.js';
import { comparePostureSnapshots } from '../services/postureDrift.js';
import { forecastAssetRisk } from '../services/riskForecast.js';
import { buildComplianceAssessment } from '../services/compliance.js';
import { addRemediationDependency, loadDigitalTwin, runCyberDecision, runWhatIfSimulation } from '../services/cyberDecision.js';
import { exportOrganizationSbom } from '../services/supplyChain.js';
import { buildAiSecurityReport } from '../services/aiSecurity.js';

export const decisionRouter = Router();
decisionRouter.use(requireAuth);

const snapshotIdSchema = z.string().uuid();

decisionRouter.get('/drift', requirePermission('report:view'), async (req, res) => {
  const before = snapshotIdSchema.safeParse(req.query.before);
  const after = snapshotIdSchema.safeParse(req.query.after);
  if (!before.success || !after.success) return res.status(400).json({ error: 'invalid_snapshot_ids', requestId: req.id });
  try {
    const comparison = await comparePostureSnapshots(req.auth.orgId, before.data, after.data);
    if (!comparison) return res.status(404).json({ error: 'snapshot_not_found', requestId: req.id });
    res.json(comparison);
  } catch (error) {
    res.status(400).json({ error: 'incompatible_snapshots', detail: String(error.message || error), requestId: req.id });
  }
});

decisionRouter.get('/forecast/assets/:assetId', requirePermission('report:view'), async (req, res) => {
  const assetId = z.string().uuid().safeParse(req.params.assetId);
  const horizon = z.coerce.number().int().min(1).max(365).default(30).safeParse(req.query.horizonDays);
  if (!assetId.success || !horizon.success) return res.status(400).json({ error: 'invalid_request', requestId: req.id });
  res.json(await forecastAssetRisk(req.auth.orgId, assetId.data, horizon.data));
});

decisionRouter.get('/compliance', requirePermission('report:view'), async (req, res) => {
  res.json(await buildComplianceAssessment(req.auth.orgId));
});

decisionRouter.get('/digital-twin', requirePermission('report:view'), async (req, res) => {
  res.json(await loadDigitalTwin(req.auth.orgId));
});

decisionRouter.get('/ai-security', requirePermission('report:view'), async (req, res) => {
  res.json(await buildAiSecurityReport(req.auth.orgId));
});

decisionRouter.get('/sbom', requirePermission('report:view'), async (req, res) => {
  const format = req.query.format === 'SPDX' ? 'SPDX' : 'CYCLONEDX';
  res.json(await exportOrganizationSbom(req.auth.orgId, format));
});

const scenarioSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PATCH_CVE'), cveId: z.string().regex(/^CVE-\d{4}-\d{4,}$/i) }),
  z.object({ type: z.literal('ENABLE_MFA'), entityKey: z.string().min(1), findingId: z.string().uuid().optional() }),
  z.object({ type: z.literal('REMOVE_PERMISSION'), entityKey: z.string().min(1), findingId: z.string().uuid().optional() }),
  z.object({ type: z.literal('REMOVE_INTERNET_EXPOSURE'), entityKey: z.string().min(1), findingId: z.string().uuid().optional() }),
  z.object({ type: z.literal('ADD_SEGMENTATION'), entityKey: z.string().min(1).optional(), sourceKey: z.string().min(1).optional(), targetKey: z.string().min(1).optional(), findingId: z.string().uuid().optional() }),
  z.object({ type: z.literal('REQUIRE_HUMAN_APPROVAL'), entityKey: z.string().min(1), findingId: z.string().uuid().optional() }),
  z.object({ type: z.literal('DISABLE_MCP_TOOL'), entityKey: z.string().min(1), findingId: z.string().uuid().optional() }),
  z.object({ type: z.literal('ROTATE_WORKLOAD_IDENTITY'), entityKey: z.string().min(1), findingId: z.string().uuid().optional() }),
]).refine(
  (value) => value.type !== 'ADD_SEGMENTATION' || value.entityKey || value.sourceKey || value.targetKey || value.findingId,
  'a graph or finding selector is required'
);

decisionRouter.post('/simulate', requirePermission('finding:update'), async (req, res) => {
  const parsed = scenarioSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_scenario', details: parsed.error.flatten(), requestId: req.id });
  res.json(await runWhatIfSimulation({ orgId: req.auth.orgId, actorUserId: req.auth.userId, scenario: parsed.data }));
});

const decisionSchema = z.object({ effortBudget: z.number().int().min(1).max(10_000).default(5) });

decisionRouter.post('/recommend', requirePermission('finding:update'), async (req, res) => {
  const parsed = decisionSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request', requestId: req.id });
  res.json(await runCyberDecision({ orgId: req.auth.orgId, actorUserId: req.auth.userId, effortBudget: parsed.data.effortBudget }));
});

const remediationDependencySchema = z.object({
  remediationId: z.string().uuid(),
  dependsOnRemediationId: z.string().uuid(),
  reason: z.string().min(1).max(1_000),
}).refine((value) => value.remediationId !== value.dependsOnRemediationId, 'a remediation cannot depend on itself');

decisionRouter.post('/remediation-dependencies', requirePermission('finding:update'), async (req, res) => {
  const parsed = remediationDependencySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request', requestId: req.id });
  const dependency = await addRemediationDependency({ orgId: req.auth.orgId, ...parsed.data });
  if (!dependency) return res.status(404).json({ error: 'remediation_not_found', requestId: req.id });
  res.status(201).json({ dependency });
});
