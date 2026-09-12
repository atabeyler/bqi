import { formatLocalDateTime } from './dateTime.js';

const SENSITIVE_KEY = /(authorization|cookie|password|secret|token(?!hash)|credential|api.?key|session)/i;
const SUBTITLE = 'BQI - BCI SECURITY INTELLIGENCE';

const CYBER_VALUE_KEYS = Object.freeze({
  QUEUED: 'cyberValueQueued', DISCOVERY: 'cyberValueDiscovery', ANALYZING: 'cyberValueAnalyzing',
  NORMALIZING: 'cyberValueNormalizing', VERIFYING: 'cyberValueVerifying', CORRELATING: 'cyberValueCorrelating',
  SCORING: 'cyberValueScoring', REPORTING: 'cyberValueReporting', COMPLETED: 'cyberValueCompleted',
  NO_COVERAGE: 'cyberValueNoCoverage', FAILED: 'cyberValueFailed', TIMED_OUT: 'cyberValueTimedOut',
  CANCELLED: 'cyberValueCancelled', SKIPPED: 'cyberValueSkipped', NEW: 'cyberValueNew',
  CONFIRMED: 'cyberValueConfirmed', ASSIGNED: 'cyberValueAssigned', IN_REMEDIATION: 'cyberValueInRemediation',
  READY_FOR_VERIFICATION: 'cyberValueReadyForVerification', VERIFIED_FIXED: 'cyberValueVerifiedFixed',
  FALSE_POSITIVE: 'cyberValueFalsePositive', ACCEPTED_RISK: 'cyberValueAcceptedRisk', MITIGATED: 'cyberValueMitigated',
  DEFERRED: 'cyberValueDeferred', UNVERIFIED: 'cyberValueUnverified', LIKELY: 'cyberValueLikely',
  MANUAL_REVIEW_REQUIRED: 'cyberValueManualReview', REJECTED: 'cyberValueRejected',
  IMMEDIATE: 'cyberValueImmediate', '24_HOURS': 'cyberValue24Hours', HIGH_PRIORITY: 'cyberValueHighPriority',
  STANDARD: 'cyberValueStandard', LOW: 'cyberValueLow', MEDIUM: 'cyberValueMedium', HIGH: 'cyberValueHigh',
  CRITICAL: 'cyberValueCritical', PASSIVE: 'cyberValuePassive', SAFE_ACTIVE: 'cyberValueSafeActive',
  AUTHENTICATED: 'cyberValueAuthenticated', RESTRICTED: 'cyberValueRestricted', ORG_WIDE: 'cyberValueOrgWide',
  ASSET: 'cyberValueAsset', VALID: 'cyberIntegrityValid', INVALID: 'cyberIntegrityTampered',
  STABLE: 'cyberValueStable', RECOVERED: 'cyberValueRecovered', INCONCLUSIVE: 'cyberValueInconclusive',
  ERROR: 'cyberValueError', BASE: 'cyberValueBase', USER: 'cyberValueUser', AI_ADAPTIVE: 'cyberValueAiAdaptive',
  EXECUTIVE: 'cyberReportTypeExecutive', TECHNICAL: 'cyberReportTypeTechnical', REMEDIATION: 'cyberReportTypeRemediation',
  AUDIT: 'cyberReportTypeAudit', FULL: 'cyberReportTypeFull', VERIFIED: 'cyberControlledProofStatusVerified',
});

const REPORT_FIELD_KEYS = Object.freeze({
  language: 'cyberReportFieldLanguage', presentation: 'cyberReportFieldPresentation', title: 'cyberColTitle',
  description: 'cyberReportFieldDescription', scopedToTargets: 'cyberReportFieldScopedTargets', securityScore: 'cyberSecurityScore',
  coverageScore: 'cyberCoverageScore', securityCoverageScoreScope: 'cyberReportFieldScoreScope', openFindingCount: 'cyberOpenFindings',
  criticalFindingCount: 'cyberReportFieldCriticalFindings', highFindingCount: 'cyberReportFieldHighFindings',
  kevExposureCount: 'cyberReportFieldKevExposure', topRisks: 'cyberReportFieldTopRisks', findingCount: 'cyberFindingCount',
  findings: 'cyberNavFindings', executionProvenance: 'cyberReportFieldExecutionProvenance', items: 'cyberReportFieldItems',
  eventCount: 'cyberReportFieldEventCount', events: 'cyberReportFieldEvents', window: 'cyberReportFieldWindow', from: 'cyberReportFieldFrom',
  to: 'cyberReportFieldTo', sectionScopes: 'cyberReportFieldSectionScopes', executive: 'cyberReportTypeExecutive',
  technical: 'cyberReportTypeTechnical', remediation: 'cyberReportTypeRemediation', audit: 'cyberReportTypeAudit',
  id: 'cyberReportFieldId', finding_id: 'cyberReportFieldFindingId', remediation_id: 'cyberReportFieldRemediationId',
  scan_job_id: 'cyberReportFieldScanId', target: 'cyberColTarget', category: 'cyberReportFieldCategory', priority: 'cyberColPriority',
  risk_score: 'cyberColRisk', confidence_score: 'cyberReportFieldConfidence', status: 'cyberColStatus',
  verification_status: 'cyberReportFieldVerification', recommendation: 'cyberReportFieldRecommendation',
  remediation_status: 'cyberReportFieldRemediationStatus', assignee_user_id: 'cyberReportFieldAssignee',
  actor_user_id: 'cyberReportFieldActor', action: 'cyberReportFieldAction', target_type: 'cyberReportFieldTargetType',
  target_id: 'cyberReportFieldTargetId', result: 'cyberReportFieldResult', metadata: 'cyberReportFieldMetadata', created_at: 'cyberColCreated',
  sources: 'cyberReportFieldSources', engine_id: 'cyberColEngine', capability_id: 'cyberReportFieldCapability',
  rule_id: 'cyberReportFieldRule', location: 'cyberReportFieldLocation', engine_severity: 'cyberReportFieldSeverity',
  evidence: 'cyberControlledProofEvidence', recommended_capability_ids: 'cyberReportFieldRecommendedCapabilities',
  selected_capability_ids: 'cyberReportFieldSelectedCapabilities', recommended_engine_ids: 'cyberReportFieldRecommendedEngines',
  selected_engine_ids: 'cyberReportFieldSelectedEngines', recommended_compute_mode: 'cyberReportFieldRecommendedCompute',
  selected_compute_mode: 'cyberReportFieldSelectedCompute', requested_engine_scopes: 'cyberReportFieldRequestedScopes',
  actual_executed_capabilities: 'cyberReportFieldExecutedCapabilities', actual_executed_engines: 'cyberReportFieldExecutedEngines',
  executed_engine_scopes: 'cyberReportFieldExecutedScopes',
  module: 'cyberReportFieldModule', source: 'cyberReportFieldSource', method: 'cyberReportFieldMethod',
  endpoint: 'cyberReportFieldEndpoint', parameter: 'cyberReportFieldParameter', anomalous: 'cyberReportFieldAnomalous',
});

const REJECTION_EXPLANATION_KEYS = Object.freeze({
  NOT_WEB_CONTENT_IMPACT_SIGNAL: 'cyberControlledProofRejectNotContentImpact',
  NO_COMPATIBLE_RESPONSE_VALIDATOR: 'cyberControlledProofRejectNoValidator',
  exact_marker_not_observed_in_supported_response: 'cyberControlledProofRejectExactMarker',
  VALIDATOR_EXECUTION_FAILED: 'cyberControlledProofRejectValidatorFailed',
});

const CONTROLLED_PROOF_VALUE_KEYS = Object.freeze({
  READY: 'cyberControlledProofStatusReady',
  ANALYZING: 'cyberControlledProofAnalyzing',
  FAILED: 'cyberControlledProofStatusFailed',
  CANCELLED: 'cyberControlledProofStatusCancelled',
  AVAILABLE: 'cyberControlledProofStatusAvailable',
  UNAVAILABLE: 'cyberControlledProofStatusUnavailable',
  ACTIVATING: 'cyberControlledProofStatusActivating',
  ACTIVE: 'cyberControlledProofPublicActive',
  VERIFIED: 'cyberControlledProofStatusVerified',
  EXPIRED: 'cyberControlledProofStatusExpired',
  STOPPED: 'cyberControlledProofStatusStopped',
  NOT_APPLICABLE: 'cyberControlledProofStatusNotApplicable',
  NOT_CONFIGURED: 'cyberControlledProofStatusNotConfigured',
  CONFIGURED: 'cyberControlledProofStatusConfigured',
  IMPLEMENTED: 'cyberControlledProofStatusImplemented',
  BLOCKED: 'cyberControlledProofStatusBlocked',
  UNSUPPORTED: 'cyberControlledProofStatusUnsupported',
  NO_PATH: 'cyberControlledProofNoPath',
  POTENTIAL: 'cyberControlledProofPotential',
  VERIFIED_IMPACT_PATH: 'cyberControlledProofVerifiedPath',
  security_impact_not_verified: 'cyberControlledProofReasonImpactNotVerified',
  configured_adapter_does_not_match_detected_infrastructure: 'cyberControlledProofReasonAdapterMismatch',
  no_configured_adapter_for_detected_provider: 'cyberControlledProofReasonNoConfiguredAdapter',
  provider_not_configured_for_target: 'cyberControlledProofReasonProviderNotConfigured',
  public_visibility_provider_unavailable: 'cyberControlledProofReasonProviderUnavailable',
  provider_unavailable_during_expiry: 'cyberControlledProofReasonProviderUnavailableExpiry',
  public_visibility_route_conflict: 'cyberControlledProofReasonRouteConflict',
  public_marker_not_observed: 'cyberControlledProofReasonMarkerNotObserved',
  exact_marker_not_observed_in_supported_response: 'cyberControlledProofReasonExactMarkerNotObserved',
  controlled_proof_transport_unavailable: 'cyberControlledProofReasonTransportUnavailable',
  controlled_proof_worker_queue_failed: 'cyberControlledProofReasonWorkerQueueFailed',
  controlled_proof_worker_failed: 'cyberControlledProofReasonWorkerFailed',
  controlled_proof_worker_timed_out: 'cyberControlledProofReasonWorkerTimedOut',
  tls_certificate_validation_failed: 'cyberControlledProofReasonTlsValidationFailed',
  deterministic_impact_not_verified: 'cyberControlledProofReasonDeterministicImpactNotVerified',
  invalid_target: 'cyberControlledProofReasonInvalidTarget',
  cancelled_by_user: 'cyberControlledProofReasonCancelled',
  response_body_transform_requires_edge_deployment: 'cyberControlledProofReasonEdgeDeployment',
  response_body_transform_not_supported_by_rules_engine: 'cyberControlledProofReasonRulesEngineNoBodyTransform',
  response_body_transform_requires_site_deployment: 'cyberControlledProofReasonSiteDeployment',
  origin_change_has_no_safe_self_expiry: 'cyberControlledProofReasonNoSafeSelfExpiry',
  requires_preinstalled_response_transform: 'cyberControlledProofReasonPreinstalledTransform',
  cms_content_change_is_persistent: 'cyberControlledProofReasonPersistentCmsChange',
  unknown_infrastructure_no_verified_management_path: 'cyberControlledProofReasonUnknownInfrastructure',
});

function translated(translate, key, fallback) {
  if (!translate) return fallback;
  const value = translate(key);
  return value && value !== key ? value : fallback;
}

export function localizedCyberValue(value, translate = null) {
  if (value == null || value === '') return '-';
  if (typeof value === 'boolean') return translated(translate, value ? 'cyberWizYes' : 'cyberWizNo', value ? 'YES' : 'NO');
  const key = CYBER_VALUE_KEYS[value];
  return key ? translated(translate, key, String(value)) : String(value);
}

export function reportFieldLabel(key, translate = null) {
  const translationKey = REPORT_FIELD_KEYS[key];
  return translationKey ? translated(translate, translationKey, key) : key;
}

function formatDate(value, locale) {
  return value ? formatLocalDateTime(value, locale) : '-';
}

function structuredMarkdown(value, translate, depth = 2) {
  if (Array.isArray(value)) {
    if (value.length === 0) return translated(translate, 'cyberControlledProofNoData', 'No data.');
    return value.map((item, index) => {
      if (item && typeof item === 'object') return `\n${'#'.repeat(Math.min(depth, 6))} ${translated(translate, 'cyberReportItem', 'Item')} ${index + 1}\n\n${structuredMarkdown(item, translate, depth + 1)}`;
      return `- ${localizedCyberValue(item, translate)}`;
    }).join('\n');
  }
  if (value && typeof value === 'object') {
    return Object.entries(safeObject(value)).map(([key, item]) => {
      const label = reportFieldLabel(key, translate);
      if (item && typeof item === 'object') return `\n${'#'.repeat(Math.min(depth, 6))} ${label}\n\n${structuredMarkdown(item, translate, depth + 1)}`;
      return `- ${label}: ${localizedCyberValue(item, translate)}`;
    }).join('\n');
  }
  return localizedCyberValue(value, translate);
}

export function controlledProofDisplayValue(value, translate = null) {
  if (value == null || value === '') return '-';
  const key = CONTROLLED_PROOF_VALUE_KEYS[value];
  return key ? translated(translate, key, String(value)) : String(value);
}

function safeScalar(value) {
  if (value == null || value === '') return '-';
  if (typeof value === 'boolean') return value ? 'YES' : 'NO';
  return String(value).replace(/\r?\n/g, ' ').slice(0, 2000);
}

function safeObject(value, depth = 0) {
  if (depth > 6) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => safeObject(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SENSITIVE_KEY.test(key) ? '[REDACTED]' : safeObject(item, depth + 1),
  ]));
}

function rows(title, values, columns, emptyText = 'No data.') {
  if (!values?.length) return `\n## ${title}\n\n${emptyText}\n`;
  const body = values.map((value) => `- ${columns.map((column) => `${column.label}: ${safeScalar(column.value(value))}`).join(' ; ')}`).join('\n');
  return `\n## ${title}\n\n${body}\n`;
}

export function controlledProofRejectionExplanation(reason, translate = null) {
  const key = REJECTION_EXPLANATION_KEYS[reason];
  if (key && translate) return translate(key);
  if (reason === 'NOT_WEB_CONTENT_IMPACT_SIGNAL') return 'The observation does not contain a verified signal that can affect delivered web content.';
  if (reason === 'NO_COMPATIBLE_RESPONSE_VALIDATOR') return 'A content-impact signal exists, but no supported non-destructive response validator can verify it.';
  if (reason === 'exact_marker_not_observed_in_supported_response') return 'The bounded marker request completed, but the exact marker was not observed in a supported response.';
  if (reason === 'VALIDATOR_EXECUTION_FAILED') return 'The safe validator could not complete; no impact was inferred from the failed execution.';
  return translate ? translate('cyberControlledProofRejectUnknown') : 'The candidate did not meet the deterministic Controlled Proof eligibility rules.';
}

function groupedRejections(rejections = [], translate = null) {
  const grouped = new Map();
  for (const rejection of rejections) {
    const engine = rejection.engineId || 'unknown';
    const reason = rejection.reason || 'UNKNOWN';
    const key = `${engine}\u0000${reason}`;
    const current = grouped.get(key) || { engine, reason, count: 0 };
    current.count += Number(rejection.count) || 1;
    grouped.set(key, current);
  }
  return [...grouped.values()].map((item) => ({
    ...item,
    explanation: controlledProofRejectionExplanation(item.reason, translate),
  }));
}

function baseReport(title, filename, content, translate = null) {
  return { title, filename, category: 'BCI', subtitle: translated(translate, 'cyberReportSubtitle', SUBTITLE), content };
}

export function buildScanExportReport({ job, engineRuns = [], findings = [], resilienceRounds = [], fuzzExecutions = [], intrusiveExecutions = [] }, { translate = null, locale = 'en' } = {}) {
  const label = (key, fallback) => translated(translate, key, fallback);
  const title = `${label('cyberScanExportTitle', 'BCI Scan Result')} - ${job.target}`;
  let content = `- ${label('cyberReportFieldScanId', 'Scan ID')}: ${safeScalar(job.id)}\n- ${label('cyberColTarget', 'Target')}: ${safeScalar(job.target)}\n- ${label('cyberColClass', 'Requested Class')}: ${localizedCyberValue(job.requested_class, translate)}\n- ${label('cyberColStatus', 'Status')}: ${localizedCyberValue(job.status, translate)}\n- ${label('cyberColCreated', 'Created')}: ${formatDate(job.created_at, locale)}\n`;
  const noData = label('cyberControlledProofNoData', 'No data.');
  content += rows(label('cyberScanEngineRunsTitle', 'Engine Runs'), engineRuns, [
    { label: label('cyberColEngine', 'Engine'), value: (item) => item.engine_id }, { label: label('cyberColStatus', 'Status'), value: (item) => localizedCyberValue(item.status, translate) },
    { label: label('cyberWizObservations', 'Observations'), value: (item) => item.observation_count ?? 0 },
    { label: label('bciDetailColumnLabel', 'Detail'), value: (item) => item.detail || '—' },
  ], noData);
  content += rows(label('cyberScanFindingsTitle', 'Findings'), findings, [
    { label: label('cyberColTitle', 'Title'), value: (item) => item.title }, { label: label('cyberColPriority', 'Priority'), value: (item) => localizedCyberValue(item.priority, translate) },
    { label: label('cyberColRisk', 'Risk'), value: (item) => item.risk_score }, { label: label('cyberColStatus', 'Status'), value: (item) => localizedCyberValue(item.status, translate) },
  ], noData);
  content += rows(label('cyberScanResilienceRoundsTitle', 'Resilience Results'), resilienceRounds, [
    { label: label('cyberReportFieldModule', 'Module'), value: (item) => item.module }, { label: label('cyberColStatus', 'Status'), value: (item) => localizedCyberValue(item.status, translate) }, { label: label('cyberReportFieldSource', 'Source'), value: (item) => localizedCyberValue(item.source, translate) },
  ], noData);
  const probes = fuzzExecutions.flatMap((execution) => execution.probes || []);
  content += rows(label('cyberScanFuzzResultsTitle', 'Smart Fuzz Results'), probes, [
    { label: label('cyberReportFieldSource', 'Source'), value: (item) => localizedCyberValue(item.source || item.type, translate) }, { label: label('cyberReportFieldMethod', 'Method'), value: (item) => item.method },
    { label: label('cyberReportFieldEndpoint', 'Endpoint'), value: (item) => item.endpoint }, { label: label('cyberReportFieldParameter', 'Parameter'), value: (item) => item.parameter },
    { label: label('cyberReportFieldAnomalous', 'Anomalous'), value: (item) => localizedCyberValue(item.anomalous, translate) },
    { label: label('bciDetailColumnLabel', 'Detail'), value: (item) => item.errorCode ? `${item.errorCode}: ${item.error || ''}` : '—' },
  ], noData);
  const intrusive = intrusiveExecutions.flatMap((execution) => execution.records || []);
  content += rows(label('cyberScanIntrusiveResultsTitle', 'Intrusive Validation Results'), intrusive, [
    { label: label('cyberReportFieldModule', 'Module'), value: (item) => item.module }, { label: label('cyberReportFieldVerification', 'Verification'), value: (item) => localizedCyberValue(item.verificationStatus, translate) }, { label: label('cyberReportFieldSource', 'Source'), value: (item) => localizedCyberValue(item.source, translate) },
  ], noData);
  return baseReport(title, `BCI_SCAN_${job.id}`, content, translate);
}

export function buildFindingExportReport({ finding, sources = [] }) {
  const title = `BCI Finding - ${finding.title}`;
  let content = `- Finding ID: ${safeScalar(finding.id)}\n- Target: ${safeScalar(finding.target)}\n- Category: ${safeScalar(finding.category)}\n- Priority: ${safeScalar(finding.priority)}\n- Risk Score: ${safeScalar(finding.risk_score)}\n- Confidence: ${safeScalar(finding.confidence_score)}\n- Status: ${safeScalar(finding.status)}\n- Verification: ${safeScalar(finding.verification_status)}\n`;
  content += rows('Evidence Sources', sources, [
    { label: 'Engine', value: (item) => item.engine_id }, { label: 'Capability', value: (item) => item.capability_id },
    { label: 'Rule', value: (item) => item.rule_id }, { label: 'Location', value: (item) => item.location },
  ]);
  return baseReport(title, `BCI_FINDING_${finding.id}`, content);
}

export function buildBciReportExport(report, { translate = null, locale = 'en' } = {}) {
  const label = (key, fallback) => translated(translate, key, fallback);
  const title = `${label('cyberBciReportTitle', 'BCI Report')} - ${localizedCyberValue(report.report_type, translate)}`;
  const content = `- ${label('cyberReportFieldId', 'Report ID')}: ${safeScalar(report.id)}\n- ${label('cyberColAsset', 'Asset ID')}: ${safeScalar(report.asset_id)}\n- ${label('cyberColBciVersion', 'BCI Version')}: ${safeScalar(report.bci_version)}\n- ${label('cyberHashLabel', 'Content Hash')}: ${safeScalar(report.content_hash)}\n- ${label('cyberIntegrityLabel', 'Integrity')}: ${report.integrityValid ? tValue('VALID') : tValue('INVALID')}\n- ${label('cyberColGenerated', 'Generated')}: ${formatDate(report.created_at, locale)}\n\n## ${label('cyberReportContentTitle', 'Report Content')}\n\n${structuredMarkdown(report.content, translate)}\n`;
  function tValue(value) { return localizedCyberValue(value, translate); }
  return baseReport(title, `BCI_REPORT_${report.id}`, content, translate);
}

export function buildControlledProofExportReport(run, { translate = null, locale = 'en' } = {}) {
  const title = `${translated(translate, 'cyberControlledProofTitle', 'Controlled Proof')} - ${run.proofId}`;
  const evidence = run.securityEvidence || {};
  const delivery = run.securityEvidence?.deliveryProviderDiscovery;
  const selection = run.securityEvidence?.publicVisibilitySelection;
  const rejections = groupedRejections(evidence.candidateRejectionSummary?.length ? evidence.candidateRejectionSummary : evidence.candidateRejections, translate);
  const label = (key, fallback) => translated(translate, key, fallback);
  const yes = label('cyberWizYes', 'YES');
  const no = label('cyberWizNo', 'NO');
  let content = `## ${label('cyberControlledProofSecurityImpact', 'Security Impact')}\n\n- ${label('cyberControlledProofTarget', 'Target')}: ${safeScalar(run.normalizedTarget || run.target)}\n- ${label('cyberControlledProofCanonicalTarget', 'Canonical Target')}: ${safeScalar(evidence.canonicalTarget)}\n- ${label('cyberColStatus', 'Status')}: ${controlledProofDisplayValue(run.securityImpact, translate)}\n- ${label('cyberControlledProofValidator', 'Validator')}: ${safeScalar(run.securityValidator)}\n- ${label('cyberControlledProofId', 'Proof ID')}: ${safeScalar(run.proofId)}\n- ${label('cyberControlledProofStarted', 'Started')}: ${formatDate(run.startedAt, locale)}\n- ${label('cyberControlledProofCompleted', 'Completed')}: ${formatDate(run.completedAt, locale)}\n- ${label('cyberControlledProofEvidenceHash', 'Evidence Hash')}: ${safeScalar(run.evidenceHash)}\n- ${label('cyberControlledProofEndpoints', 'Endpoints Discovered')}: ${safeScalar(evidence.endpointsDiscovered ?? 0)}\n- ${label('cyberControlledProofMatchedEvidence', 'Evidence Observations Matched')}: ${safeScalar(evidence.evidenceObservationsMatched ?? 0)}\n- ${label('cyberControlledProofImpactSignals', 'Content-impact Signals Matched')}: ${safeScalar(evidence.evidenceImpactSignalsMatched ?? 0)}\n- ${label('cyberControlledProofCandidates', 'Proof Candidates Resolved')}: ${safeScalar(evidence.evidenceCandidatesResolved ?? 0)}\n`;
  const noData = label('cyberControlledProofNoData', 'No data.');
  content += rows(label('cyberControlledProofEngineCoverage', 'Engine Evidence Coverage'), Object.entries(evidence.evidenceEngineCoverage || {}), [
    { label: label('cyberControlledProofEngine', 'Engine'), value: ([engine]) => engine },
    { label: label('cyberControlledProofEvidence', 'Evidence'), value: ([, coverage]) => coverage.observations ?? 0 },
    { label: label('cyberControlledProofCandidates', 'Proof Candidates'), value: ([, coverage]) => coverage.candidates ?? 0 },
    { label: label('cyberControlledProofRejected', 'Rejected'), value: ([, coverage]) => coverage.rejected ?? 0 },
  ], noData);
  content += rows(label('cyberControlledProofLiveEngineExecution', 'Live Engine Execution'), evidence.liveEngineExecutions || [], [
    { label: label('cyberControlledProofEngine', 'Engine'), value: (item) => item.engineId },
    { label: label('cyberColStatus', 'Status'), value: (item) => item.status },
    { label: label('cyberColVersion', 'Version'), value: (item) => item.version },
    { label: label('cyberControlledProofRawRecords', 'Raw Records'), value: (item) => item.rawRecords ?? 0 },
    { label: label('cyberControlledProofAttemptedChecks', 'Attempted Checks'), value: (item) => item.attemptedChecks },
    { label: label('cyberControlledProofEvidence', 'Observations'), value: (item) => item.observations ?? 0 },
    { label: label('cyberControlledProofReason', 'Reason'), value: (item) => item.reason },
  ], noData);
  content += `\n## ${label('cyberControlledProofFindingEvidence', 'Finding Evidence')}\n\n${label('cyberControlledProofEvidenceSeparation', 'Finding Evidence records scanner observations. Controlled Proof of Impact is a separate deterministic validation result.')}\n`;
  content += rows(label('cyberControlledProofSecurityObservations', 'Security Observations'), evidence.securityObservations || [], [
    { label: label('cyberControlledProofObservationTitle', 'Finding'), value: (item) => item.title },
    { label: label('cyberControlledProofSeverity', 'Severity'), value: (item) => item.severity },
    { label: label('cyberControlledProofTechnicalEvidence', 'Technical evidence'), value: (item) => item.technicalEvidence },
    { label: label('cyberControlledProofLocation', 'Target URL'), value: (item) => item.location },
    { label: label('cyberControlledProofEngine', 'Engine'), value: (item) => item.engineId },
    { label: label('cyberControlledProofRule', 'Rule'), value: (item) => item.ruleId },
    { label: label('cyberControlledProofEvidenceHash', 'Evidence Hash'), value: (item) => item.evidenceHash },
    { label: label('cyberControlledProofPossibleImpact', 'Possible security impact'), value: (item) => item.possibleImpact },
    { label: label('cyberControlledProofDetectedTechnology', 'Detected technology'), value: (item) => item.technology },
    { label: label('cyberControlledProofRecommendedRemediation', 'Recommended remediation'), value: (item) => item.remediation },
    { label: label('cyberControlledProofPostFixValidation', 'Post-fix revalidation'), value: (item) => item.revalidation },
    { label: label('cyberControlledProofVerification', 'Verification'), value: (item) => item.verificationStatus },
    { label: label('cyberControlledProofEligibility', 'Proof Eligibility'), value: (item) => item.proofEligibility },
  ], noData);
  content += rows(label('cyberControlledProofRejectionReasons', 'Candidate Rejection Reasons'), rejections, [
    { label: label('cyberControlledProofEngine', 'Engine'), value: (item) => item.engine },
    { label: label('cyberControlledProofReasonCode', 'Reason Code'), value: (item) => item.reason },
    { label: label('cyberControlledProofCount', 'Count'), value: (item) => item.count },
    { label: label('cyberControlledProofExplanation', 'Explanation'), value: (item) => item.explanation },
  ], noData);
  content += `\n## ${label('cyberControlledProofPublicTitle', 'Customer-visible Public Proof')}\n\n- ${label('cyberControlledProofPublicVisibility', 'Public Visibility')}: ${controlledProofDisplayValue(run.publicProofStatus, translate)}\n- ${label('cyberControlledProofAdapter', 'Adapter')}: ${safeScalar(run.publicValidator || selection?.providerId)}\n- ${label('cyberControlledProofAdapterSelection', 'Adapter Selection')}: ${controlledProofDisplayValue(selection?.status, translate)}\n- ${label('cyberControlledProofSelectionReason', 'Selection Reason')}: ${controlledProofDisplayValue(selection?.reason, translate)}\n- ${label('cyberControlledProofVisibilityVerified', 'Visibility Verified')}: ${run.publicVisibilityVerified ? yes : no}\n- ${label('cyberControlledProofStarted', 'Started')}: ${safeScalar(run.publicStartedAt)}\n- ${label('cyberControlledProofExpires', 'Expires')}: ${safeScalar(run.publicExpiresAt)}\n- ${label('cyberControlledProofPublicEvidenceHash', 'Public Evidence Hash')}: ${safeScalar(run.publicEvidenceHash)}\n`;
  content += rows(label('cyberControlledProofDetectedProviders', 'Detected Delivery Providers'), delivery?.candidates || [], [
    { label: label('cyberControlledProofProvider', 'Provider'), value: (item) => item.providerLabel || item.providerId },
    { label: label('cyberControlledProofConfidence', 'Confidence'), value: (item) => item.confidence },
    { label: label('cyberControlledProofAdapter', 'Adapter'), value: (item) => item.adapterId || item.adapterStatus },
    { label: label('cyberControlledProofBlockingReason', 'Technical limitation'), value: (item) => controlledProofDisplayValue(item.blockingReason, translate) },
  ], noData);
  content += rows(label('cyberControlledProofSupportMatrix', 'Public Visibility Support Matrix'), delivery?.supportMatrix || [], [
    { label: label('cyberControlledProofProvider', 'Provider'), value: (item) => item.label || item.id },
    { label: label('cyberColStatus', 'Status'), value: (item) => controlledProofDisplayValue(item.adapterStatus, translate) },
    { label: label('cyberControlledProofAdapter', 'Adapter'), value: (item) => item.adapterId },
    { label: label('cyberControlledProofBlockingReason', 'Technical limitation'), value: (item) => controlledProofDisplayValue(item.blockingReason, translate) },
  ], noData);
  if (run.failureReason || run.publicFailureReason) content += `\n## ${label('cyberControlledProofFailureInformation', 'Failure Information')}\n\n- ${label('cyberControlledProofAnalyze', 'Analysis')}: ${controlledProofDisplayValue(run.failureReason, translate)}\n- ${label('cyberControlledProofPublicTitle', 'Public Proof')}: ${controlledProofDisplayValue(run.publicFailureReason, translate)}\n`;
  return baseReport(title, `BCI_CONTROLLED_PROOF_${run.proofId}`, content, translate);
}

export const _internal = { safeObject };
