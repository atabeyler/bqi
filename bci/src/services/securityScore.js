import { query } from '../db/client.js';

// Security Score v1 (spec section 28): explicitly NOT a simple average of
// open findings' severities -- a handful of high-risk open findings should
// hurt more than many low-risk ones, and closed/accepted findings must
// stop counting against the score at all. risk_score already folds in
// asset criticality (services/risk.js), so this doesn't need to re-weight
// by asset separately.
export const SECURITY_SCORE_MODEL_VERSION = 1;

// Exported so anything else needing "is this finding still live" (e.g.
// services/assetSummary.js) shares this exact definition instead of
// re-declaring its own, possibly-diverging list.
export const CLOSED_STATUSES = ['FALSE_POSITIVE', 'VERIFIED_FIXED', 'ACCEPTED_RISK', 'MITIGATED'];

function deductionFor(riskScore) {
  if (riskScore >= 90) return 20;
  if (riskScore >= 75) return 10;
  if (riskScore >= 50) return 4;
  if (riskScore >= 25) return 1;
  return 0.2;
}

export function computeSecurityScoreFromRiskScores(riskScores) {
  const totalDeduction = riskScores.reduce((sum, r) => sum + deductionFor(r), 0);
  return Math.round(Math.max(0, 100 - totalDeduction));
}

export async function computeSecurityScore(orgId) {
  const { rows } = await query(
    `SELECT risk_score FROM findings
      WHERE org_id = $1 AND risk_score IS NOT NULL AND status <> ALL($2)`,
    [orgId, CLOSED_STATUSES]
  );
  const riskScores = rows.map((r) => r.risk_score);
  return {
    score: computeSecurityScoreFromRiskScores(riskScores),
    openFindingCount: riskScores.length,
    modelVersion: SECURITY_SCORE_MODEL_VERSION,
  };
}
