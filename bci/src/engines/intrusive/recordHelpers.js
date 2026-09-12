// Shared shape every intrusive validation module returns from run() --
// the rich, per-execution provenance record the spec requires: module,
// target, endpoint/service, test type, source (stamped by the adapter,
// not the module itself -- a module doesn't know whether it's running as
// BASE/AI_ADAPTIVE/USER), baseline, observed result, evidence,
// verification status, related finding, and round number.
export function buildRecord({
  moduleId, family, target, endpoint, testType, baseline, observed, evidence,
  verificationStatus, relatedFindingId = null, roundNumber = 1, anomalous, anomalyReasons = [],
}) {
  return {
    type: 'INTRUSIVE_VALIDATION_RECORD',
    module: moduleId,
    family,
    target,
    endpoint: endpoint ?? target,
    testType,
    baseline: baseline ?? null,
    observed,
    evidence,
    // VERIFIED requires the module to have actually executed and observed
    // real, corroborating evidence -- never assigned just because a probe
    // ran without error. UNVERIFIED/NOT_APPLICABLE/ERROR are all real,
    // honest outcomes; a module that couldn't execute reports ERROR, not
    // a silently-passing VERIFIED.
    verificationStatus,
    relatedFindingId,
    round: { number: roundNumber, previous: null, next: null },
    anomalous: !!anomalous,
    anomalyReasons,
  };
}

// A module whose real network execution failed outright (connection
// error, timeout) -- reported honestly as ERROR/not-anomalous, never
// disguised as a completed, clean check.
export function errorRecord({ moduleId, family, target, endpoint, testType, error, roundNumber = 1 }) {
  return buildRecord({
    moduleId, family, target, endpoint, testType, baseline: null, observed: null,
    evidence: { error: String(error?.message || error) }, verificationStatus: 'ERROR',
    roundNumber, anomalous: false,
  });
}
