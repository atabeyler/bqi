import { query } from '../db/client.js';
import { computeAssetSummary } from './assetSummary.js';

// Called once a scan job genuinely COMPLETED (never for NO_COVERAGE/FAILED/
// CANCELLED/TIMED_OUT -- those didn't change anything about the asset's
// risk, so snapshotting them would just be noise, not history). A target
// can match more than one asset (e.g. two assets sharing an identifier is
// unusual but not impossible), so this snapshots every asset the job's
// target actually resolves to via asset_identifiers, the same matching
// convention used everywhere else (risk.js, coverageScore.js, etc.).
export async function recordAssetRiskSnapshotsForTarget(orgId, target, scanJobId) {
  const { rows: assetRows } = await query(
    `SELECT DISTINCT a.id FROM assets a JOIN asset_identifiers ai ON ai.asset_id = a.id
      WHERE a.org_id = $1 AND ai.value = $2`,
    [orgId, target]
  );

  for (const { id: assetId } of assetRows) {
    const summary = await computeAssetSummary(orgId, assetId);
    await query(
      `INSERT INTO asset_risk_snapshots (org_id, asset_id, scan_job_id, risk_score, open_finding_count, priority_breakdown)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [orgId, assetId, scanJobId, summary.riskScore, summary.openFindingCount, JSON.stringify(summary.priorityBreakdown)]
    );
  }
}

export async function listAssetRiskHistory(orgId, assetId) {
  const { rows } = await query(
    `SELECT id, scan_job_id, risk_score, open_finding_count, priority_breakdown, computed_at
       FROM asset_risk_snapshots WHERE org_id = $1 AND asset_id = $2 ORDER BY computed_at DESC`,
    [orgId, assetId]
  );
  return rows;
}
