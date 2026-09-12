import { query } from '../db/client.js';
import { computeSecurityScore } from '../services/securityScore.js';
import { computeCoverageScore } from '../services/coverageScore.js';

const OPEN_STATUSES = ['NEW', 'CONFIRMED', 'ASSIGNED', 'IN_REMEDIATION', 'READY_FOR_VERIFICATION', 'DEFERRED'];

// `targets`, when given (routes/reports.js resolves it from an assetId's
// real asset_identifiers), scopes a report to one asset's findings using
// the exact same target-string-match convention as risk.js/coverageScore.js
// elsewhere. securityScore/coverageScore themselves stay ORG-WIDE always --
// computeSecurityScore()/computeCoverageScore() have no per-target mode,
// and faking one by filtering their inputs client-side here would silently
// misrepresent what those two numbers actually mean. scopedToTargets in the
// output says plainly what was and wasn't narrowed.
function targetFilterClause(targets, paramIndex) {
  if (targets == null) return { clause: '', param: null };
  if (targets.length === 0) return { clause: ' AND FALSE', param: null };
  return { clause: ` AND target = ANY($${paramIndex})`, param: targets };
}

function scanFindingFilterClause(scanJobId, paramIndex, alias = 'findings.') {
  if (!scanJobId) return { clause: '', param: null };
  const findingId = `${alias}id`;
  return {
    clause: ` AND EXISTS (
      SELECT 1 FROM finding_sources scan_fs
      JOIN normalized_observations scan_no ON scan_no.id = scan_fs.normalized_observation_id
      WHERE scan_fs.finding_id = ${findingId} AND scan_no.org_id = $1 AND scan_no.job_id = $${paramIndex}
    )`,
    param: scanJobId,
  };
}

// Executive Report (spec section 45): the numbers a CISO/leadership reads,
// never raw engine output or per-finding technical detail.
export async function buildExecutiveReport(orgId, { targets, scanJobId } = {}) {
  const [security, coverage] = await Promise.all([computeSecurityScore(orgId), computeCoverageScore(orgId)]);

  const findingsFilter = targetFilterClause(targets, 3);
  const findingsScanFilter = scanFindingFilterClause(scanJobId, findingsFilter.param ? 4 : 3);
  const findingsParams = [orgId, OPEN_STATUSES, ...(findingsFilter.param ? [findingsFilter.param] : []), ...(findingsScanFilter.param ? [findingsScanFilter.param] : [])];
  const { rows: openFindings } = await query(
    `SELECT priority, risk_score FROM findings WHERE org_id = $1 AND status = ANY($2)${findingsFilter.clause}${findingsScanFilter.clause}`,
    findingsParams
  );
  const criticalCount = openFindings.filter((f) => f.priority === 'IMMEDIATE').length;
  const highCount = openFindings.filter((f) => f.priority === '24_HOURS').length;

  const topRisksFilter = targetFilterClause(targets, 3);
  const topRisksScanFilter = scanFindingFilterClause(scanJobId, topRisksFilter.param ? 4 : 3);
  const { rows: topRisks } = await query(
    `SELECT id, title, target, risk_score, priority FROM findings
      WHERE org_id = $1 AND status = ANY($2) AND risk_score IS NOT NULL${topRisksFilter.clause}${topRisksScanFilter.clause}
      ORDER BY risk_score DESC LIMIT 5`,
    [orgId, OPEN_STATUSES, ...(topRisksFilter.param ? [topRisksFilter.param] : []), ...(topRisksScanFilter.param ? [topRisksScanFilter.param] : [])]
  );

  const kevFilter = targetFilterClause(targets, 3);
  const kevScanFilter = scanFindingFilterClause(scanJobId, kevFilter.param ? 4 : 3, 'f.');
  const { rows: kevExposure } = await query(
    `SELECT count(DISTINCT f.id)::int AS n
       FROM findings f, unnest(f.cve_ids) AS finding_cve_id
       JOIN vulnerabilities v ON v.cve_id = finding_cve_id AND v.kev = true
      WHERE f.org_id = $1 AND f.status = ANY($2)${kevFilter.clause.replace('target', 'f.target')}${kevScanFilter.clause}`,
    [orgId, OPEN_STATUSES, ...(kevFilter.param ? [kevFilter.param] : []), ...(kevScanFilter.param ? [kevScanFilter.param] : [])]
  );

  return {
    scopedToTargets: targets ?? null,
    scopedToScanJobId: scanJobId ?? null,
    securityScore: security.score,
    coverageScore: coverage.score,
    securityCoverageScoreScope: 'ORG_WIDE',
    openFindingCount: openFindings.length,
    criticalFindingCount: criticalCount,
    highFindingCount: highCount,
    kevExposureCount: kevExposure[0].n,
    topRisks,
  };
}

// Technical Report (spec section 45): full detail for security/IT --
// every open finding plus which engines corroborated it.
export async function buildTechnicalReport(orgId, { targets, scanJobId } = {}) {
  const filter = targetFilterClause(targets, 2);
  const scanFilter = scanFindingFilterClause(scanJobId, filter.param ? 3 : 2);
  const { rows: findings } = await query(
    `SELECT * FROM findings WHERE org_id = $1${filter.clause}${scanFilter.clause} ORDER BY risk_score DESC NULLS LAST`,
    [orgId, ...(filter.param ? [filter.param] : []), ...(scanFilter.param ? [scanFilter.param] : [])]
  );

  for (const finding of findings) {
    const { rows: sources } = await query(
      `SELECT fs.engine_id, no.capability_id, no.job_id AS scan_job_id, no.rule_id, no.location, no.engine_severity, no.evidence
         FROM finding_sources fs JOIN normalized_observations no ON no.id = fs.normalized_observation_id
        WHERE fs.finding_id = $1${scanJobId ? ' AND no.job_id = $2' : ''}`,
      scanJobId ? [finding.id, scanJobId] : [finding.id]
    );
    finding.sources = sources;
  }

  const provenanceFilter = targetFilterClause(targets, 2);
  const provenanceScanClause = scanJobId ? ` AND id = $${provenanceFilter.param ? 3 : 2}` : '';
  const { rows: executionProvenance } = await query(
    `SELECT id AS scan_job_id, target, recommended_capability_ids, selected_capability_ids,
            recommended_engine_ids, selected_engine_ids, recommended_compute_mode, selected_compute_mode,
            engine_options AS requested_engine_scopes,
            result->'actualExecutedCapabilities' AS actual_executed_capabilities,
            result->'enginesRun' AS actual_executed_engines,
            (SELECT jsonb_object_agg(ro.engine_id, COALESCE(ro.payload->'executionMeta', ro.payload->'discoveryMeta', ro.payload->'moduleMeta'))
               FROM raw_observations ro WHERE ro.job_id = scan_jobs.id) AS executed_engine_scopes
       FROM scan_jobs WHERE org_id = $1 AND controlled_proof_run_id IS NULL${provenanceFilter.clause}${provenanceScanClause} ORDER BY created_at DESC`,
    [orgId, ...(provenanceFilter.param ? [provenanceFilter.param] : []), ...(scanJobId ? [scanJobId] : [])]
  );

  return { scopedToTargets: targets ?? null, scopedToScanJobId: scanJobId ?? null, findingCount: findings.length, findings, executionProvenance };
}

// Remediation Report (spec section 45): for developers/DevOps -- what to
// fix, grouped by where it stands in the remediation lifecycle.
export async function buildRemediationReport(orgId, { targets, scanJobId } = {}) {
  const filter = targetFilterClause(targets, 2);
  const scanFilter = scanFindingFilterClause(scanJobId, filter.param ? 3 : 2, 'f.');
  const { rows } = await query(
    `SELECT f.id AS finding_id, f.title, f.status, f.priority, f.target,
            r.id AS remediation_id, r.recommendation, r.status AS remediation_status, r.assignee_user_id
       FROM findings f
       LEFT JOIN remediations r ON r.finding_id = f.id
      WHERE f.org_id = $1 AND f.status <> 'FALSE_POSITIVE'${filter.clause.replace('target', 'f.target')}${scanFilter.clause}
      ORDER BY f.priority NULLS LAST, f.risk_score DESC NULLS LAST`,
    [orgId, ...(filter.param ? [filter.param] : []), ...(scanFilter.param ? [scanFilter.param] : [])]
  );
  return { scopedToTargets: targets ?? null, scopedToScanJobId: scanJobId ?? null, items: rows };
}

// Audit/Compliance Evidence Report (spec section 45): the audit ledger
// itself, for a fixed window -- this report IS the compliance evidence,
// not a summary of it. Deliberately never asset-scoped: audit events cover
// logins, admin actions, and other org-level activity that isn't tied to
// any single asset, so filtering by target would silently drop evidence
// rather than narrow it meaningfully.
export async function buildAuditReport(orgId, { from, to } = {}) {
  const params = [orgId];
  let where = 'org_id = $1';
  if (from) {
    params.push(from);
    where += ` AND created_at >= $${params.length}`;
  }
  if (to) {
    params.push(to);
    where += ` AND created_at <= $${params.length}`;
  }

  const { rows } = await query(
    `SELECT id, actor_user_id, action, target_type, target_id, result, metadata, created_at
       FROM audit_events WHERE ${where} ORDER BY created_at ASC`,
    params
  );
  return { eventCount: rows.length, events: rows, window: { from: from ?? null, to: to ?? null } };
}

// FULL BCI Report: bundles the other four builders' output into one
// artifact, additive only -- generating one never removes or changes the
// independent EXECUTIVE/TECHNICAL/REMEDIATION/AUDIT report types, which
// keep working exactly as before.
export async function buildFullReport(orgId, options = {}) {
  const [executive, technical, remediation, audit] = await Promise.all([
    buildExecutiveReport(orgId, options),
    buildTechnicalReport(orgId, options),
    buildRemediationReport(orgId, options),
    buildAuditReport(orgId, options),
  ]);
  return {
    scopedToTargets: options.targets ?? null,
    scopedToScanJobId: options.scanJobId ?? null,
    sectionScopes: { executive: options.scanJobId ? 'SCAN' : options.targets ? 'ASSET' : 'ORG_WIDE', technical: options.scanJobId ? 'SCAN' : options.targets ? 'ASSET' : 'ORG_WIDE', remediation: options.scanJobId ? 'SCAN' : options.targets ? 'ASSET' : 'ORG_WIDE', audit: 'ORG_WIDE' },
    executive, technical, remediation, audit,
  };
}
