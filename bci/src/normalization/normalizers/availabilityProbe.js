const SEVERITY_BY_STATUS = {
  SATURATED: 'MEDIUM',
  DEGRADING: 'LOW',
  RECOVERY_FAILED: 'MEDIUM',
  RATE_LIMITED: 'LOW', // informational -- confirms a real protective mechanism, not itself a weakness
};

const TITLE_BY_STATUS = {
  SATURATED: 'Target reached real capacity saturation under load',
  DEGRADING: 'Real performance degradation observed under load',
  RECOVERY_FAILED: 'Target did not recover to baseline after real load',
  RATE_LIMITED: 'Rate limiting observed to trigger under real load',
};

// BCI Smart Resilience -- turns real RESILIENCE_ROUND records (bci/src/
// engines/resilience/*) into findings. A round is only ever a finding
// when BOTH anomalous === true AND status is one of the real,
// measurement-derived anomaly statuses -- INCONCLUSIVE (no real samples,
// or too few to classify) never becomes a finding, and a round with a
// real `error` (the module itself couldn't execute) never does either.
export function normalizeAvailabilityProbe(rawPayload) {
  const rounds = Array.isArray(rawPayload?.raw) ? rawPayload.raw : [];
  return rounds
    .filter((r) => r?.type === 'RESILIENCE_ROUND' && r.anomalous === true && !r.error && SEVERITY_BY_STATUS[r.status])
    .map((round) => ({
      category: 'AVAILABILITY_RESILIENCE',
      capabilityId: 'DOS',
      ruleId: `BCI-RESILIENCE-${round.status}`,
      title: TITLE_BY_STATUS[round.status],
      description: `BCI Smart Resilience's ${round.module} module (${round.source === 'AI_ADAPTIVE' ? 'AI-adaptive' : round.source === 'USER' ? 'user-selected' : 'base'} round ${round.round?.number ?? 1}) observed: ${round.status}. Requested ${round.requestedPlan?.totalRequests ?? 'UNLIMITED'} requests @ ${round.requestedPlan?.concurrency ?? '?'} concurrency; executed ${round.executedPlan?.totalRequests ?? 'UNLIMITED'} @ ${round.executedPlan?.concurrency ?? '?'}.`,
      engineSeverity: SEVERITY_BY_STATUS[round.status],
      cveIds: [],
      cweIds: [],
      location: round.target || 'target',
      evidence: {
        capability: 'DOS',
        module: round.module,
        family: round.family,
        // BASE / USER / AI_ADAPTIVE -- kept distinct in provenance, never
        // merged into one undifferentiated source.
        source: round.source,
        roundNumber: round.round?.number ?? 1,
        status: round.status,
        requestedPlan: round.requestedPlan ?? null,
        executedPlan: round.executedPlan ?? null,
        clamps: round.clamps ?? [],
        metrics: round.metrics ?? null,
        degradation: round.degradation ?? null,
        runtimeLimitations: round.runtimeLimitations ?? [],
        relatedFindingId: round.relatedFindingId ?? null,
      },
      references: [],
    }));
}
