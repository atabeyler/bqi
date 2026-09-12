import { query } from '../db/client.js';
import { CLOSED_STATUSES } from './securityScore.js';

// An asset has no direct FK from scan_jobs/findings -- both are linked to
// it only by target string matching one of its asset_identifiers.value
// rows, the same convention services/risk.js, coverageScore.js, and
// remediationOptimizer.js already use. This is real data assembled from
// that existing join, never a fabricated per-asset score: an asset with no
// identifiers yet (never had a target attached) or one that's never been
// scanned comes back with nulls/zeros/empty arrays, not invented numbers.
//
// priorityBreakdown uses BCI's own priority scale (IMMEDIATE/24_HOURS/
// HIGH_PRIORITY/PLANNED/MONITOR, services/risk.js#computePriority) rather
// than a generic Critical/High/Medium/Low label BCI does not actually
// produce anywhere -- normalization.js keeps an engine's own severity
// string only for audit (engine_severity), it is never surfaced as BCI's
// own verdict (spec section: "BCI karar verir, engine değil").
export async function computeAssetSummary(orgId, assetId) {
  const { rows: identifierRows } = await query(
    'SELECT value FROM asset_identifiers WHERE asset_id = $1',
    [assetId]
  );
  const targets = identifierRows.map((r) => r.value);

  if (targets.length === 0) {
    return {
      targets: [],
      lastScan: null,
      findingCount: 0,
      openFindingCount: 0,
      priorityBreakdown: {},
      riskScore: null,
    };
  }

  const [{ rows: scanRows }, { rows: findingRows }] = await Promise.all([
    query(
      `SELECT id, status, requested_class, created_at, updated_at
         FROM scan_jobs
        WHERE org_id = $1 AND controlled_proof_run_id IS NULL AND target = ANY($2::text[])
        ORDER BY created_at DESC
        LIMIT 1`,
      [orgId, targets]
    ),
    query(
      `SELECT status, priority, risk_score
         FROM findings
        WHERE org_id = $1 AND target = ANY($2::text[])`,
      [orgId, targets]
    ),
  ]);

  const openFindings = findingRows.filter((f) => !CLOSED_STATUSES.includes(f.status));
  const priorityBreakdown = {};
  for (const f of openFindings) {
    const key = f.priority || 'UNSCORED';
    priorityBreakdown[key] = (priorityBreakdown[key] || 0) + 1;
  }
  const openRiskScores = openFindings.map((f) => f.risk_score).filter((v) => v != null);
  // The asset's own risk score is the worst live finding on it, not an
  // average -- one CRITICAL finding must not get diluted into looking fine
  // by a pile of low-risk ones, same principle as services/securityScore.js.
  const riskScore = openRiskScores.length ? Math.max(...openRiskScores) : null;

  return {
    targets,
    lastScan: scanRows[0] || null,
    findingCount: findingRows.length,
    openFindingCount: openFindings.length,
    priorityBreakdown,
    riskScore,
  };
}
