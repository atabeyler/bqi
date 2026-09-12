// Confidence Engine v1 (spec section 24). Confidence is deliberately kept
// separate from Risk: a CRITICAL-severity finding with low confidence must
// still read as "needs manual verification," not get hidden or silently
// promoted. Deterministic and versioned for the same reason as
// verification.js -- an old score must stay explainable.
export const CONFIDENCE_MODEL_VERSION = 1;

const BASE_BY_SOURCE_COUNT = { 1: 40, 2: 65 }; // 3+ sources -> 85 (see below)

function baseScoreForSourceCount(count) {
  if (count >= 3) return 85;
  return BASE_BY_SOURCE_COUNT[count] ?? 0;
}

export function computeConfidenceScore(observations, verificationStatus) {
  if (observations.length === 0) return 0;

  const distinctEngines = new Set(observations.map((o) => o.engine_id));
  let score = baseScoreForSourceCount(distinctEngines.size);

  if (verificationStatus === 'CONFIRMED') score += 10;

  // A concrete CVSS score is a stronger, more specific signal than a bare
  // CVE id with no scoring behind it yet.
  if (observations.some((o) => o.cvss_score != null)) score += 5;

  // An unresolved finding still needing a human look can't simultaneously
  // read as high-confidence -- that combination is exactly the "manual
  // verification required" case spec section 24 describes.
  if (verificationStatus === 'MANUAL_REVIEW_REQUIRED') score = Math.min(score, 50);

  return Math.max(0, Math.min(100, score));
}
