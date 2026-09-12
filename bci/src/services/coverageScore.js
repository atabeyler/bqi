import { query } from '../db/client.js';

// Coverage Score (spec section 29): a Security Score is meaningless without
// saying how much of the inventory it's actually based on. This says, per
// asset type, which analysis categories are expected, and what fraction of
// that expected coverage has ever actually been observed.
export const COVERAGE_SCORE_MODEL_VERSION = 1;

export const EXPECTED_CATEGORIES_BY_ASSET_TYPE = {
  REPOSITORY: ['SAST', 'SCA', 'SECRETS'],
  CONTAINER: ['SCA', 'SECRETS', 'IAC'],
  WEB_APP: ['WEB'],
  API: ['API'],
  HOST: ['NETWORK_DISCOVERY'],
  CLOUD_RESOURCE: ['IAC'],
  DOMAIN: ['WEB'],
  IDENTITY: [],
  SERVICE: [],
};

export async function computeCoverageScore(orgId) {
  const { rows: assets } = await query(
    `SELECT a.id, a.asset_type,
            array_agg(DISTINCT ai.value) FILTER (WHERE ai.value IS NOT NULL) AS identifiers
       FROM assets a
       LEFT JOIN asset_identifiers ai ON ai.asset_id = a.id
      WHERE a.org_id = $1
      GROUP BY a.id, a.asset_type`,
    [orgId]
  );

  if (assets.length === 0) {
    return { score: 0, reason: 'no_assets', modelVersion: COVERAGE_SCORE_MODEL_VERSION };
  }

  let expectedTotal = 0;
  let coveredTotal = 0;

  for (const asset of assets) {
    const expectedCategories = EXPECTED_CATEGORIES_BY_ASSET_TYPE[asset.asset_type] || [];
    if (expectedCategories.length === 0) continue;

    const targets = asset.identifiers?.length ? asset.identifiers : [];
    const { rows: observedRows } =
      targets.length > 0
        ? await query(
            `SELECT DISTINCT category FROM normalized_observations WHERE org_id = $1 AND target = ANY($2)`,
            [orgId, targets]
          )
        : { rows: [] };
    const observedCategories = new Set(observedRows.map((r) => r.category));

    expectedTotal += expectedCategories.length;
    coveredTotal += expectedCategories.filter((c) => observedCategories.has(c)).length;
  }

  if (expectedTotal === 0) {
    return { score: 0, reason: 'no_expected_categories', modelVersion: COVERAGE_SCORE_MODEL_VERSION };
  }

  return {
    score: Math.round((coveredTotal / expectedTotal) * 100),
    expectedTotal,
    coveredTotal,
    modelVersion: COVERAGE_SCORE_MODEL_VERSION,
  };
}
