import { query } from '../db/client.js';
import { sha256 } from './core.js';
import { findingGuidance } from './findingGuidance.js';

const RELEVANT_ENGINES = ['nuclei', 'http-fuzz', 'intrusive-validation', 'naabu'];

function siteKey(hostname) {
  return String(hostname || '').toLowerCase().replace(/^www\./, '');
}

function asUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`;
    const parsed = new URL(withScheme);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed : null;
  } catch {
    return null;
  }
}

function matchesTarget(row, targetUrls) {
  const keys = new Set(targetUrls.map((url) => siteKey(url.hostname)));
  const values = [row.target, row.location, row.evidence?.endpoint, row.evidence?.observed?.location].filter(Boolean);
  return values.some((value) => {
    const url = asUrl(value);
    return url && keys.has(siteKey(url.hostname));
  });
}

function endpointAndParameter(row) {
  if (row.engine_id === 'http-fuzz') {
    const endpoint = asUrl(row.evidence?.endpoint);
    const parameter = row.evidence?.parameter;
    const location = row.evidence?.location;
    if (endpoint && parameter && location === 'query') return { endpoint: endpoint.toString(), parameter };
  }
  const locationUrl = asUrl(row.location);
  if (locationUrl && [...locationUrl.searchParams.keys()].length > 0) {
    return { endpoint: locationUrl.toString(), parameter: [...locationUrl.searchParams.keys()][0] };
  }
  return null;
}

function isContentImpactSignal(row) {
  if (row.engine_id === 'http-fuzz') {
    return row.evidence?.reflected === true || row.evidence?.anomalyReasons?.includes('payload_reflected_unescaped');
  }
  if (row.engine_id === 'intrusive-validation') {
    return row.evidence?.anomalyReasons?.some((reason) => [
      'host_header_reflected_in_body', 'host_header_reflected_in_redirect', 'prior_finding_reproduced',
    ].includes(reason));
  }
  if (row.engine_id === 'nuclei') {
    return /(?:xss|cross-site-scripting|html[-_ ]?injection|content[-_ ]?injection|template[-_ ]?injection|cache[-_ ]?poison|host[-_ ]?header)/i.test(row.rule_id || '');
  }
  return false;
}

function safeLocation(value) {
  const url = asUrl(value);
  if (url) {
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  }
  return typeof value === 'string' ? value.slice(0, 240) : null;
}

function observationSummary(row, contentImpactSignal, proofEligibility, providerIds = []) {
  return {
    observationId: row.id || null,
    findingId: row.finding_id || null,
    engineId: row.engine_id,
    ruleId: row.rule_id || null,
    title: row.title || row.evidence?.module || row.rule_id || 'Untitled observation',
    category: row.category || row.evidence?.category || null,
    severity: row.engine_severity || row.severity || row.evidence?.severity || null,
    location: safeLocation(row.location || row.evidence?.endpoint || row.target),
    verificationStatus: row.verification_status || row.evidence?.verificationStatus || 'OBSERVED',
    contentImpactSignal,
    proofEligibility,
    ...findingGuidance(row, providerIds),
    // Raw request/response evidence is deliberately not copied into the
    // report. Its digest keeps the visible summary traceable to the exact
    // normalized observation without exposing cookies, tokens or bodies.
    evidenceHash: sha256(row.evidence || {}),
  };
}

export function resolveCandidatesFromObservations(rows, targetUrls, { providerIds = [] } = {}) {
  const matched = rows.filter((row) => matchesTarget(row, targetUrls));
  const engineCoverage = Object.fromEntries(RELEVANT_ENGINES.map((engineId) => [engineId, {
    observations: matched.filter((row) => row.engine_id === engineId).length,
    candidates: 0,
    rejected: 0,
  }]));
  const candidates = [];
  const rejections = [];
  const observationSummaries = [];
  const seen = new Set();
  let impactSignalsMatched = 0;

  for (const row of matched) {
    const contentImpactSignal = isContentImpactSignal(row);
    if (!contentImpactSignal) {
      engineCoverage[row.engine_id].rejected += 1;
      rejections.push({ engineId: row.engine_id, findingId: row.finding_id, reason: 'NOT_WEB_CONTENT_IMPACT_SIGNAL' });
      observationSummaries.push(observationSummary(row, false, 'NOT_WEB_CONTENT_IMPACT_SIGNAL', providerIds));
      continue;
    }
    impactSignalsMatched += 1;
    const resolved = endpointAndParameter(row);
    if (!resolved) {
      engineCoverage[row.engine_id].rejected += 1;
      rejections.push({ engineId: row.engine_id, findingId: row.finding_id, reason: 'NO_COMPATIBLE_RESPONSE_VALIDATOR' });
      observationSummaries.push(observationSummary(row, true, 'NO_COMPATIBLE_RESPONSE_VALIDATOR', providerIds));
      continue;
    }
    const key = `${resolved.endpoint}|${resolved.parameter}`;
    if (seen.has(key)) continue;
    seen.add(key);
    engineCoverage[row.engine_id].candidates += 1;
    observationSummaries.push(observationSummary(row, true, 'CANDIDATE', providerIds));
    candidates.push({
      ...resolved,
      source: `existing-evidence:${row.engine_id}`,
      engineId: row.engine_id,
      findingId: row.finding_id,
      observationId: row.id,
      ruleId: row.rule_id,
    });
  }

  const rejectionSummary = Object.values(rejections.reduce((summary, rejection) => {
    const key = `${rejection.engineId}:${rejection.reason}`;
    summary[key] ||= { engineId: rejection.engineId, reason: rejection.reason, count: 0 };
    summary[key].count += 1;
    return summary;
  }, {}));
  return { candidates, rejections, rejectionSummary, engineCoverage, observationSummaries, observationsMatched: matched.length, impactSignalsMatched };
}

export async function resolveControlledProofCandidates(orgId, targetUrls, { additionalRows = [], jobId = null, providerIds = [] } = {}) {
  const { rows } = await query(
    `SELECT no.id, no.engine_id, no.rule_id, no.title, no.category, no.engine_severity,
            no.target, no.location, no.evidence,
            f.id AS finding_id, f.verification_status
       FROM normalized_observations no
       LEFT JOIN finding_sources fs ON fs.normalized_observation_id=no.id
       LEFT JOIN findings f ON f.id=fs.finding_id
      WHERE no.org_id=$1 AND no.engine_id=ANY($2::text[])
        AND ($3::uuid IS NULL OR no.job_id=$3)
        AND (f.id IS NULL OR f.status <> 'FALSE_POSITIVE')
      ORDER BY no.created_at DESC LIMIT 500`,
    [orgId, RELEVANT_ENGINES, jobId]
  );
  return resolveCandidatesFromObservations([...additionalRows, ...rows], targetUrls, { providerIds });
}

export const CONTROLLED_PROOF_EVIDENCE_ENGINES = Object.freeze([...RELEVANT_ENGINES]);
