import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../lib/rbac.js';
import {
  analyzeControlledProofTarget, archiveControlledProofRun, cancelControlledProofRun,
  getControlledProofRun, listControlledProofRuns, startPublicVisibilityProof, stopPublicVisibilityProof,
  unarchiveControlledProofRun, deleteControlledProofRun,
} from '../services/controlledProofEngine.js';

export const controlledProofRouter = Router();

const proofLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.auth.userId,
  message: { error: 'rate_limited' },
});

const analyzeSchema = z.object({
  targetUrl: z.string().min(1).max(2048),
}).strict();
const idSchema = z.string().uuid();
const publicProofSchema = z.object({ durationSeconds: z.number().int().min(5).max(30) }).strict();

controlledProofRouter.use(requireAuth, requirePermission('system:manage'));

controlledProofRouter.post('/analyze', proofLimiter, async (req, res) => {
  const parsed = analyzeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request', requestId: req.id });
  try {
    const run = await analyzeControlledProofTarget({
      orgId: req.auth.orgId, actorUserId: req.auth.userId, target: parsed.data.targetUrl,
    });
    return res.status(202).json({ run });
  } catch (error) {
    if (error instanceof TypeError && error.message === 'invalid_target') {
      return res.status(400).json({ error: 'invalid_target', requestId: req.id });
    }
    throw error;
  }
});

controlledProofRouter.get('/history', async (req, res) => {
  res.json({ runs: await listControlledProofRuns(req.auth.orgId, { archivedOnly: req.query.archived === 'true' }) });
});

controlledProofRouter.get('/:id', async (req, res) => {
  const parsedId = idSchema.safeParse(req.params.id);
  if (!parsedId.success) return res.status(400).json({ error: 'invalid_request', requestId: req.id });
  const run = await getControlledProofRun(req.auth.orgId, parsedId.data);
  if (!run) return res.status(404).json({ error: 'controlled_proof_not_found', requestId: req.id });
  return res.json({ run });
});

controlledProofRouter.post('/:id/public-proof/start', proofLimiter, async (req, res) => {
  const parsedId = idSchema.safeParse(req.params.id);
  const parsed = publicProofSchema.safeParse(req.body);
  if (!parsedId.success || !parsed.success) return res.status(400).json({ error: 'invalid_request', requestId: req.id });
  const run = await startPublicVisibilityProof({ orgId: req.auth.orgId, actorUserId: req.auth.userId, runId: parsedId.data, durationSeconds: parsed.data.durationSeconds });
  if (!run) return res.status(409).json({ error: 'public_proof_not_available', requestId: req.id });
  return res.json({ run });
});

controlledProofRouter.post('/:id/public-proof/stop', proofLimiter, async (req, res) => {
  const parsedId = idSchema.safeParse(req.params.id);
  if (!parsedId.success || Object.keys(req.body || {}).length > 0) return res.status(400).json({ error: 'invalid_request', requestId: req.id });
  const run = await stopPublicVisibilityProof({ orgId: req.auth.orgId, actorUserId: req.auth.userId, runId: parsedId.data });
  if (!run) return res.status(409).json({ error: 'public_proof_not_active', requestId: req.id });
  if (run.publicProofStatus === 'ACTIVE') return res.status(409).json({ error: 'public_proof_stop_failed', run, requestId: req.id });
  return res.json({ run });
});

controlledProofRouter.post('/:id/cancel', proofLimiter, async (req, res) => {
  const parsedId = idSchema.safeParse(req.params.id);
  if (!parsedId.success || Object.keys(req.body || {}).length > 0) return res.status(400).json({ error: 'invalid_request', requestId: req.id });
  const run = await cancelControlledProofRun({ orgId: req.auth.orgId, actorUserId: req.auth.userId, runId: parsedId.data });
  if (!run) return res.status(404).json({ error: 'controlled_proof_not_found_or_terminal', requestId: req.id });
  return res.json({ run });
});

controlledProofRouter.post('/:id/archive', async (req, res) => {
  const parsedId = idSchema.safeParse(req.params.id);
  if (!parsedId.success || Object.keys(req.body || {}).length > 0) return res.status(400).json({ error: 'invalid_request', requestId: req.id });
  const run = await archiveControlledProofRun({ orgId: req.auth.orgId, actorUserId: req.auth.userId, runId: parsedId.data });
  if (!run) return res.status(404).json({ error: 'controlled_proof_not_found_or_archived', requestId: req.id });
  return res.json({ run });
});

controlledProofRouter.post('/:id/unarchive', async (req, res) => {
  const parsedId = idSchema.safeParse(req.params.id);
  if (!parsedId.success || Object.keys(req.body || {}).length > 0) return res.status(400).json({ error: 'invalid_request', requestId: req.id });
  const run = await unarchiveControlledProofRun({ orgId: req.auth.orgId, actorUserId: req.auth.userId, runId: parsedId.data });
  if (!run) return res.status(404).json({ error: 'controlled_proof_not_found_or_active', requestId: req.id });
  return res.json({ run });
});

controlledProofRouter.delete('/:id', async (req, res) => {
  const parsedId = idSchema.safeParse(req.params.id);
  if (!parsedId.success || Object.keys(req.body || {}).length > 0) return res.status(400).json({ error: 'invalid_request', requestId: req.id });
  const run = await deleteControlledProofRun({ orgId: req.auth.orgId, actorUserId: req.auth.userId, runId: parsedId.data });
  if (!run) return res.status(409).json({ error: 'controlled_proof_not_found_or_not_terminal', requestId: req.id });
  return res.json({ run });
});
