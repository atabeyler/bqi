import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/client.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../lib/rbac.js';
import { getAllProviderHealth } from '../quantum/registry.js';
import { getQuantumPolicy, setQuantumPolicy, resolveExecutionMode } from '../quantum/executionPolicy.js';
import { optimizeRemediation } from '../services/remediationOptimizer.js';
import { recordAuditEvent } from '../services/audit.js';

export const quantumRouter = Router();

quantumRouter.use(requireAuth);

// Provider health is safe to read broadly -- it never reveals credentials
// or problem data, only mode/status/capabilities (spec section 6).
quantumRouter.get('/providers', requirePermission('rule:view'), async (_req, res) => {
  res.json({ providers: await getAllProviderHealth() });
});

quantumRouter.get('/policy', requirePermission('rule:view'), async (req, res) => {
  res.json({ policy: await getQuantumPolicy(req.auth.orgId) });
});

// BCI's own compute-method recommendation, with no preference given (spec
// section 5-6): the exact same real fallback chain (decideExecutionMode)
// that runs at actual optimize time, evaluated ahead of it purely for
// display -- so the Wizard's "BCI Recommendation" is never a client-side
// re-derivation of policy/health/size rules, always this one real
// decision. problemSize=1 mirrors jobQueue.js's own pre-scan placeholder
// (the real problem size is only known after findings exist); a caller
// that already knows its problem size may pass it to get a size-accurate
// recommendation instead.
quantumRouter.get('/recommendation', requirePermission('rule:view'), async (req, res) => {
  const problemSize = Number(req.query.problemSize) || 1;
  const dataClassification = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'SECRET'].includes(req.query.dataClassification)
    ? req.query.dataClassification
    : 'INTERNAL';
  const decision = await resolveExecutionMode({ orgId: req.auth.orgId, problemSize, dataClassification });
  res.json({ recommendedMode: decision.mode, reason: decision.reason });
});

const policySchema = z.object({
  allowQuantumSimulator: z.boolean(),
  allowQuantumHardware: z.boolean(),
  maxExternalDataClassification: z.enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'SECRET']),
});

// Changing what may leave the organization to an external quantum provider
// is an administrative security decision -- gated at system:manage, the
// same bar as the analogous engine-health-check trigger.
quantumRouter.put('/policy', requirePermission('system:manage'), async (req, res) => {
  const parsed = policySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request', requestId: req.id });

  await setQuantumPolicy(req.auth.orgId, parsed.data);
  await recordAuditEvent({
    orgId: req.auth.orgId, actorUserId: req.auth.userId, action: 'quantum.policy_update', result: 'SUCCESS', metadata: parsed.data,
  });
  res.json({ policy: parsed.data });
});

const optimizeSchema = z.object({
  effortBudget: z.number().int().positive(),
  dataClassification: z.enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'SECRET']).default('INTERNAL'),
  // All optional and additive -- omitting them keeps the pre-existing
  // org-wide, no-preference behavior byte-identical.
  findingIds: z.array(z.string().uuid()).optional(),
  preferredMode: z.enum(['CLASSICAL', 'QUANTUM_INSPIRED', 'QUANTUM_SIMULATOR', 'QUANTUM_HARDWARE']).optional(),
  scanJobId: z.string().uuid().optional(),
});

quantumRouter.post('/remediation-optimize', requirePermission('finding:update'), async (req, res) => {
  const parsed = optimizeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request', requestId: req.id });

  const result = await optimizeRemediation({
    orgId: req.auth.orgId,
    actorUserId: req.auth.userId,
    effortBudget: parsed.data.effortBudget,
    dataClassification: parsed.data.dataClassification,
    findingIds: parsed.data.findingIds,
    preferredMode: parsed.data.preferredMode,
    scanJobId: parsed.data.scanJobId,
  });
  res.json(result);
});

quantumRouter.get('/benchmarks', requirePermission('rule:view'), async (req, res) => {
  const { rows } = await query(
    'SELECT id, workload_source, verdict, created_at FROM quantum_benchmarks WHERE org_id = $1 ORDER BY created_at DESC LIMIT 50',
    [req.auth.orgId]
  );
  res.json({ benchmarks: rows });
});

quantumRouter.get('/benchmarks/:id', requirePermission('rule:view'), async (req, res) => {
  const { rows } = await query('SELECT * FROM quantum_benchmarks WHERE id = $1 AND org_id = $2', [req.params.id, req.auth.orgId]);
  if (rows.length === 0) return res.status(404).json({ error: 'benchmark_not_found', requestId: req.id });
  res.json({ benchmark: rows[0] });
});

quantumRouter.get('/jobs', requirePermission('rule:view'), async (req, res) => {
  const { rows } = await query(
    `SELECT id, benchmark_id, workload_source, provider, mode, status, qubits, shots, fallback_reason, submitted_at, completed_at
       FROM quantum_jobs WHERE org_id = $1 ORDER BY submitted_at DESC LIMIT 100`,
    [req.auth.orgId]
  );
  res.json({ jobs: rows });
});
