import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/client.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../lib/rbac.js';
import { recordAuditEvent } from '../services/audit.js';
import { computeAssetSummary } from '../services/assetSummary.js';
import { listAssetRiskHistory } from '../services/assetRiskHistory.js';

export const assetsRouter = Router();

assetsRouter.use(requireAuth);

const ASSET_TYPES = ['DOMAIN', 'HOST', 'WEB_APP', 'API', 'REPOSITORY', 'CONTAINER', 'CLOUD_RESOURCE', 'IDENTITY', 'SERVICE'];
const CRITICALITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const RELATIONSHIP_TYPES = ['HOSTS', 'DEPENDS_ON', 'CONNECTS_TO', 'CONTAINS', 'RUNS', 'EXPOSES'];
const ASSET_STATUSES = ['ACTIVE', 'ARCHIVED'];

// Every route below trusts org scoping to a WHERE org_id = $orgId clause,
// never to the caller-supplied :id alone -- an id from another tenant
// simply doesn't match and comes back as 404, not 403 (no confirmation
// that the id exists at all).
async function loadOwnedAsset(orgId, assetId) {
  const { rows } = await query('SELECT id, org_id FROM assets WHERE id = $1 AND org_id = $2', [assetId, orgId]);
  return rows[0] || null;
}

const createAssetSchema = z.object({
  name: z.string().min(1),
  assetType: z.enum(ASSET_TYPES),
  criticality: z.enum(CRITICALITIES).default('MEDIUM'),
});

// `target` is the asset's first-registered identifier (asset_identifiers.value)
// -- there is no `target` column on assets itself (see 0004_assets.sql); an
// asset can carry several identifiers (DOMAIN + IP, say), but the
// inventory list needs one representative string to show and to hand off
// to "Start Scan". Optional ?status= filters to ACTIVE or ARCHIVED; with
// no filter, every asset (any status) comes back so the UI can offer an
// "show archived" toggle without a second round trip.
const listAssetsQuerySchema = z.object({ status: z.enum(ASSET_STATUSES).optional() });

assetsRouter.get('/', requirePermission('asset:view'), async (req, res) => {
  const parsed = listAssetsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten(), requestId: req.id });
  }

  const { rows } = await query(
    `SELECT a.id, a.name, a.asset_type, a.criticality, a.status, a.created_at, a.updated_at,
            (SELECT ai.value FROM asset_identifiers ai WHERE ai.asset_id = a.id ORDER BY ai.id LIMIT 1) AS target
       FROM assets a
      WHERE a.org_id = $1 AND ($2::text IS NULL OR a.status = $2)
      ORDER BY a.created_at DESC`,
    [req.auth.orgId, parsed.data.status ?? null]
  );
  res.json({ assets: rows });
});

// Duplicate-target check for the new-asset flow (spec: don't let a second
// asset get created for a target already in the inventory) -- a real
// lookup against asset_identifiers.value, case-insensitive exact match,
// never a guess from the target string's shape. Declared before GET /:id
// so this literal path is never swallowed by that param route.
const findByTargetQuerySchema = z.object({ value: z.string().min(1) });

assetsRouter.get('/find-by-target', requirePermission('asset:view'), async (req, res) => {
  const parsed = findByTargetQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten(), requestId: req.id });
  }

  const { rows } = await query(
    `SELECT a.id, a.name, a.asset_type, a.criticality, a.status, a.created_at, a.updated_at, ai.value AS target
       FROM assets a
       JOIN asset_identifiers ai ON ai.asset_id = a.id
      WHERE a.org_id = $1 AND lower(ai.value) = lower($2)
      LIMIT 1`,
    [req.auth.orgId, parsed.data.value]
  );
  res.json({ asset: rows[0] ?? null });
});

assetsRouter.post('/', requirePermission('asset:create'), async (req, res) => {
  const parsed = createAssetSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten(), requestId: req.id });
  }
  const { name, assetType, criticality } = parsed.data;

  const { rows } = await query(
    `INSERT INTO assets (org_id, name, asset_type, criticality, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, name, asset_type, criticality, status, created_at, updated_at`,
    [req.auth.orgId, name, assetType, criticality, req.auth.userId]
  );

  await recordAuditEvent({
    orgId: req.auth.orgId,
    actorUserId: req.auth.userId,
    action: 'asset.create',
    targetType: 'asset',
    targetId: rows[0].id,
    result: 'SUCCESS',
    metadata: { name, assetType },
  });

  res.status(201).json({ asset: rows[0] });
});

assetsRouter.get('/:id', requirePermission('asset:view'), async (req, res) => {
  const asset = await loadOwnedAsset(req.auth.orgId, req.params.id);
  if (!asset) return res.status(404).json({ error: 'asset_not_found', requestId: req.id });

  const [{ rows: full }, { rows: identifiers }, { rows: technologies }, { rows: relationships }] = await Promise.all([
    query('SELECT id, name, asset_type, criticality, status, created_at, updated_at FROM assets WHERE id = $1', [req.params.id]),
    query('SELECT id, identifier_type, value FROM asset_identifiers WHERE asset_id = $1', [req.params.id]),
    query('SELECT id, name, version, detected_at FROM asset_technologies WHERE asset_id = $1', [req.params.id]),
    query(
      `SELECT id, source_asset_id, target_asset_id, relationship_type
         FROM asset_relationships WHERE org_id = $1 AND (source_asset_id = $2 OR target_asset_id = $2)`,
      [req.auth.orgId, req.params.id]
    ),
  ]);

  res.json({ asset: full[0], identifiers, technologies, relationships });
});

// status is the archive/unarchive lever (see 0021_asset_status.sql) --
// deliberately folded into the same PATCH as name/criticality rather than
// a separate DELETE or /archive endpoint: it's just another field update,
// same permission (asset:update), and it never touches asset_identifiers/
// asset_technologies/asset_relationships or any scan_jobs/findings row, so
// archiving and later restoring an asset is fully non-destructive.
const updateAssetSchema = z.object({
  name: z.string().min(1).optional(),
  criticality: z.enum(CRITICALITIES).optional(),
  status: z.enum(ASSET_STATUSES).optional(),
});

assetsRouter.patch('/:id', requirePermission('asset:update'), async (req, res) => {
  const asset = await loadOwnedAsset(req.auth.orgId, req.params.id);
  if (!asset) return res.status(404).json({ error: 'asset_not_found', requestId: req.id });

  const parsed = updateAssetSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten(), requestId: req.id });
  }
  if (Object.keys(parsed.data).length === 0) {
    return res.status(400).json({ error: 'no_fields_to_update', requestId: req.id });
  }

  const { rows } = await query(
    `UPDATE assets SET
        name = COALESCE($1, name),
        criticality = COALESCE($2, criticality),
        status = COALESCE($3, status),
        updated_at = now()
      WHERE id = $4
      RETURNING id, name, asset_type, criticality, status, created_at, updated_at`,
    [parsed.data.name ?? null, parsed.data.criticality ?? null, parsed.data.status ?? null, req.params.id]
  );

  await recordAuditEvent({
    orgId: req.auth.orgId,
    actorUserId: req.auth.userId,
    action: 'asset.update',
    targetType: 'asset',
    targetId: req.params.id,
    result: 'SUCCESS',
    metadata: parsed.data,
  });

  res.json({ asset: rows[0] });
});

// Real, derived data only -- see services/assetSummary.js for exactly what
// this is computed from and why it never fabricates a number the backend
// doesn't actually have.
assetsRouter.get('/:id/summary', requirePermission('asset:view'), async (req, res) => {
  const asset = await loadOwnedAsset(req.auth.orgId, req.params.id);
  if (!asset) return res.status(404).json({ error: 'asset_not_found', requestId: req.id });

  const summary = await computeAssetSummary(req.auth.orgId, req.params.id);
  res.json({ summary });
});

// Real, append-only point-in-time history (asset_risk_snapshots) -- one
// row per scan that actually completed for this asset's target, written
// by the worker (services/assetRiskHistory.js), never recomputed/faked
// on read.
assetsRouter.get('/:id/history', requirePermission('asset:view'), async (req, res) => {
  const asset = await loadOwnedAsset(req.auth.orgId, req.params.id);
  if (!asset) return res.status(404).json({ error: 'asset_not_found', requestId: req.id });

  const history = await listAssetRiskHistory(req.auth.orgId, req.params.id);
  res.json({ history });
});

const identifierSchema = z.object({
  identifierType: z.string().min(1),
  value: z.string().min(1),
});

assetsRouter.post('/:id/identifiers', requirePermission('asset:update'), async (req, res) => {
  const asset = await loadOwnedAsset(req.auth.orgId, req.params.id);
  if (!asset) return res.status(404).json({ error: 'asset_not_found', requestId: req.id });

  const parsed = identifierSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_request', requestId: req.id });
  }

  const { rows } = await query(
    `INSERT INTO asset_identifiers (asset_id, identifier_type, value)
     VALUES ($1, $2, $3)
     ON CONFLICT (asset_id, identifier_type, value) DO NOTHING
     RETURNING id, identifier_type, value`,
    [req.params.id, parsed.data.identifierType, parsed.data.value]
  );

  res.status(201).json({ identifier: rows[0] ?? null });
});

const technologySchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
});

assetsRouter.post('/:id/technologies', requirePermission('asset:update'), async (req, res) => {
  const asset = await loadOwnedAsset(req.auth.orgId, req.params.id);
  if (!asset) return res.status(404).json({ error: 'asset_not_found', requestId: req.id });

  const parsed = technologySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_request', requestId: req.id });
  }

  const { rows } = await query(
    `INSERT INTO asset_technologies (asset_id, name, version) VALUES ($1, $2, $3)
     RETURNING id, name, version, detected_at`,
    [req.params.id, parsed.data.name, parsed.data.version ?? null]
  );

  res.status(201).json({ technology: rows[0] });
});

const relationshipSchema = z.object({
  sourceAssetId: z.string().uuid(),
  targetAssetId: z.string().uuid(),
  relationshipType: z.enum(RELATIONSHIP_TYPES),
});

assetsRouter.post('/relationships', requirePermission('asset:update'), async (req, res) => {
  const parsed = relationshipSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_request', requestId: req.id });
  }
  const { sourceAssetId, targetAssetId, relationshipType } = parsed.data;

  const [source, target] = await Promise.all([
    loadOwnedAsset(req.auth.orgId, sourceAssetId),
    loadOwnedAsset(req.auth.orgId, targetAssetId),
  ]);
  if (!source || !target) {
    return res.status(404).json({ error: 'asset_not_found', requestId: req.id });
  }

  const { rows } = await query(
    `INSERT INTO asset_relationships (org_id, source_asset_id, target_asset_id, relationship_type)
     VALUES ($1, $2, $3, $4) RETURNING id, source_asset_id, target_asset_id, relationship_type`,
    [req.auth.orgId, sourceAssetId, targetAssetId, relationshipType]
  );

  res.status(201).json({ relationship: rows[0] });
});
