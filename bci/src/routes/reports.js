import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../lib/rbac.js';
import { archiveReport, deleteReport, generateReport, getReport, listReports } from '../services/reports.js';

export const reportsRouter = Router();

reportsRouter.use(requireAuth);

const generateSchema = z.object({
  reportType: z.enum(['EXECUTIVE', 'TECHNICAL', 'REMEDIATION', 'AUDIT', 'FULL']),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  // Scopes EXECUTIVE/TECHNICAL/REMEDIATION/FULL to one asset's real
  // identifiers (see reports.js#resolveTargetsForAsset) -- AUDIT ignores
  // this, its own builder is deliberately never asset-scoped.
  assetId: z.string().uuid().optional(),
  scanJobId: z.string().uuid().optional(),
  language: z.enum(['en', 'tr', 'fr', 'de', 'ar']).default('en'),
});

// Generating (not just viewing) a report is gated by report:export --
// producing one is the exportable-artifact action the permission catalog
// names, distinct from report:view.
reportsRouter.post('/', requirePermission('report:export'), async (req, res) => {
  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request', requestId: req.id });

  const { reportType, from, to, assetId, scanJobId, language } = parsed.data;
  try {
    const report = await generateReport(req.auth.orgId, req.auth.userId, reportType, { from, to, assetId, scanJobId, language });
    res.status(201).json({ report });
  } catch (err) {
    if (err?.message === 'scan_job_not_found') return res.status(404).json({ error: err.message, requestId: req.id });
    if (err?.message === 'scan_job_asset_mismatch') return res.status(400).json({ error: err.message, requestId: req.id });
    throw err;
  }
});

const listQuerySchema = z.object({ assetId: z.string().uuid().optional() });

reportsRouter.get('/', requirePermission('report:view'), async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request', requestId: req.id });
  res.json({ reports: await listReports(req.auth.orgId, { assetId: parsed.data.assetId }) });
});

reportsRouter.get('/:id', requirePermission('report:view'), async (req, res) => {
  const report = await getReport(req.auth.orgId, req.params.id);
  if (!report) return res.status(404).json({ error: 'report_not_found', requestId: req.id });
  res.json({ report });
});

reportsRouter.post('/:id/archive', requirePermission('report:export'), async (req, res) => {
  const report = await archiveReport({ orgId: req.auth.orgId, actorUserId: req.auth.userId, reportId: req.params.id });
  if (!report) return res.status(404).json({ error: 'report_not_found_or_already_archived', requestId: req.id });
  res.json({ report });
});

reportsRouter.delete('/:id', requirePermission('report:export'), async (req, res) => {
  const report = await deleteReport({ orgId: req.auth.orgId, actorUserId: req.auth.userId, reportId: req.params.id });
  if (!report) return res.status(404).json({ error: 'report_not_found_or_already_deleted', requestId: req.id });
  res.json({ report });
});
