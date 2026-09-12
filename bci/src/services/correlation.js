import { query } from '../db/client.js';
import { computeVerificationStatus } from './verification.js';
import { computeConfidenceScore } from './confidence.js';
import { recomputeFindingRisk } from './risk.js';

// The correlation key is what makes "Nuclei and BCI Native both flagged the
// same thing" collapse into one Finding instead of two (spec section 22).
// Priority: a shared CVE is the strongest signal a CVE carries across
// engines regardless of how each one worded its finding; failing that, the
// same rule hitting the same exact location is the next best signal;
// anything else falls back to (category + location), which is coarser but
// still keeps unrelated findings on the same file/host apart.
export function buildCorrelationKey(obs) {
  if (obs.cve_ids?.length > 0) {
    return `cve:${[...obs.cve_ids].sort().join(',')}:${obs.target}`;
  }
  if (obs.rule_id) {
    return `rule:${obs.rule_id}:${obs.location ?? obs.target}`;
  }
  return `category:${obs.category}:${obs.location ?? obs.target}`;
}

function unionArrays(...arrays) {
  return [...new Set(arrays.flat().filter(Boolean))];
}

// Idempotent: running this again over the same job's observations never
// creates duplicate Findings (UNIQUE(org_id, correlation_key) plus ON
// CONFLICT merge) and never double-counts a source (UNIQUE on
// finding_sources).
export async function correlateJobObservations(orgId, jobId) {
  const { rows: observations } = await query(
    `SELECT no.* FROM normalized_observations no
      WHERE no.org_id = $1 AND no.job_id = $2
        AND NOT EXISTS (SELECT 1 FROM finding_sources fs WHERE fs.normalized_observation_id = no.id)`,
    [orgId, jobId]
  );

  const groups = new Map();
  for (const obs of observations) {
    const key = buildCorrelationKey(obs);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(obs);
  }

  const findingIds = [];
  for (const [key, obsGroup] of groups) {
    const primary = obsGroup[0];
    const cveIds = unionArrays(...obsGroup.map((o) => o.cve_ids));
    const cweIds = unionArrays(...obsGroup.map((o) => o.cwe_ids));

    const { rows } = await query(
      `INSERT INTO findings (org_id, correlation_key, category, title, description, cve_ids, cwe_ids, component, component_version, location, target)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (org_id, correlation_key) DO UPDATE SET
         cve_ids = COALESCE((SELECT array_agg(DISTINCT x) FROM unnest(findings.cve_ids || $6) AS x), ARRAY[]::TEXT[]),
         cwe_ids = COALESCE((SELECT array_agg(DISTINCT x) FROM unnest(findings.cwe_ids || $7) AS x), ARRAY[]::TEXT[]),
         updated_at = now()
       RETURNING id`,
      [orgId, key, primary.category, primary.title, primary.description, cveIds, cweIds, primary.component, primary.component_version, primary.location, primary.target]
    );
    const findingId = rows[0].id;

    for (const obs of obsGroup) {
      await query(
        `INSERT INTO finding_sources (finding_id, normalized_observation_id, engine_id)
         VALUES ($1, $2, $3) ON CONFLICT (finding_id, normalized_observation_id) DO NOTHING`,
        [findingId, obs.id, obs.engine_id]
      );
    }

    await recomputeFindingScores(findingId);
    findingIds.push(findingId);
  }

  return [...new Set(findingIds)];
}

// Re-derives verification_status and confidence_score from ALL of a
// Finding's current sources -- called after correlation adds a source, so a
// second engine agreeing on an existing Finding can raise its confidence
// without creating a second Finding.
export async function recomputeFindingScores(findingId) {
  const { rows: sourceObs } = await query(
    `SELECT no.* FROM finding_sources fs
       JOIN normalized_observations no ON no.id = fs.normalized_observation_id
      WHERE fs.finding_id = $1`,
    [findingId]
  );

  const verificationStatus = computeVerificationStatus(sourceObs);
  const confidenceScore = computeConfidenceScore(sourceObs, verificationStatus);

  await query(
    `UPDATE findings SET verification_status = $1, confidence_score = $2, updated_at = now() WHERE id = $3`,
    [verificationStatus, confidenceScore, findingId]
  );

  // Risk depends on confidence (a low-confidence finding must read as lower
  // risk, spec section 24), so it's recomputed right after confidence is,
  // every time a source is added -- never left stale from a Finding's
  // original creation.
  await recomputeFindingRisk(findingId);
}
