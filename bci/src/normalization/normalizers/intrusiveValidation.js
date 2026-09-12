const SEVERITY_BY_REASON = {
  trace_method_accepted: 'LOW',
  cors_credentialed_origin_reflection: 'HIGH',
  cors_permissive_origin: 'MEDIUM',
  security_headers_dropped_on_error_path: 'LOW',
  version_banner_disclosed: 'LOW',
  information_disclosure_in_error_response: 'HIGH',
  host_header_reflected_in_redirect: 'HIGH',
  host_header_reflected_in_body: 'MEDIUM',
  path_normalization_access_bypass: 'HIGH',
  accept_header_specific_server_error: 'MEDIUM',
  prior_finding_reproduced: 'MEDIUM', // real severity is the ORIGINAL finding's; this only confirms it still holds
};

const TITLE_BY_REASON = {
  trace_method_accepted: 'HTTP TRACE method accepted',
  cors_credentialed_origin_reflection: 'CORS reflects untrusted Origin with credentials allowed',
  cors_permissive_origin: 'CORS reflects an untrusted Origin',
  security_headers_dropped_on_error_path: 'Security headers dropped on error-path responses',
  version_banner_disclosed: 'Server/framework version banner disclosed',
  information_disclosure_in_error_response: 'Stack trace or debug information disclosed in error response',
  host_header_reflected_in_redirect: 'Host header trusted for redirect/Location generation',
  host_header_reflected_in_body: 'Host header reflected unescaped in response body',
  path_normalization_access_bypass: 'Path normalization bypasses access restriction',
  accept_header_specific_server_error: 'Server error specific to one Accept header variant',
  prior_finding_reproduced: 'Prior finding independently reproduced',
};

// BCI Smart Intrusive -- turns real, VERIFIED, anomalous
// INTRUSIVE_VALIDATION_RECORD entries (bci/src/engines/intrusive/*) into
// findings. Deliberately never produces a finding from a record that
// isn't both anomalous AND verificationStatus === 'VERIFIED': a module
// that couldn't execute (ERROR), had nothing real to check
// (NOT_APPLICABLE), or found the original signal did NOT reproduce
// (UNVERIFIED) must never surface as a "confirmed" finding -- spec:
// "kanıt yoksa VERIFIED finding üretme."
export function normalizeIntrusiveValidation(rawPayload) {
  const records = Array.isArray(rawPayload?.raw) ? rawPayload.raw : [];
  return records
    .filter((r) => r?.type === 'INTRUSIVE_VALIDATION_RECORD' && r.anomalous === true && r.verificationStatus === 'VERIFIED' && r.anomalyReasons?.length > 0)
    .map((record) => {
      const reason = record.anomalyReasons[0];
      return {
        category: 'ACTIVE_VALIDATION',
        capabilityId: 'INTRUSIVE',
        ruleId: `BCI-INTRUSIVE-${record.module}`,
        title: TITLE_BY_REASON[reason] || `${record.family} anomaly`,
        description: `BCI Smart Intrusive's ${record.module} module (${record.source === 'AI_ADAPTIVE' ? 'AI-adaptive' : record.source === 'USER' ? 'user-selected' : 'base'} round ${record.round?.number ?? 1}) observed: ${record.anomalyReasons.join(', ')}.`,
        engineSeverity: SEVERITY_BY_REASON[reason] || 'LOW',
        cveIds: [],
        cweIds: [],
        location: record.endpoint || record.target || 'target',
        evidence: {
          capability: 'INTRUSIVE',
          module: record.module,
          family: record.family,
          testType: record.testType,
          // BASE / AI_ADAPTIVE / USER -- kept distinct in provenance,
          // never merged into one undifferentiated source.
          source: record.source,
          roundNumber: record.round?.number ?? 1,
          baseline: record.baseline ?? null,
          observed: record.observed ?? null,
          verificationStatus: record.verificationStatus,
          relatedFindingId: record.relatedFindingId ?? null,
          anomalyReasons: record.anomalyReasons,
        },
        references: [],
      };
    });
}
