const REASON_TITLES = {
  server_error: 'Boundary input triggered a server error',
  response_size_deviation: 'Boundary input produced a significantly different response size',
  latency_deviation: 'Boundary input produced a significantly slower response',
  payload_reflected_unescaped: 'Input value reflected unescaped in the response body',
};

const REASON_RULE_IDS = {
  server_error: 'BCI-HTTP-FUZZ-5XX',
  response_size_deviation: 'BCI-HTTP-FUZZ-SIZE-DEVIATION',
  latency_deviation: 'BCI-HTTP-FUZZ-LATENCY-DEVIATION',
  payload_reflected_unescaped: 'BCI-HTTP-FUZZ-REFLECTED',
};

// Severity is a real, deterministic function of WHICH behavioral
// difference(s) were observed -- a reflected-payload marker (a real
// injection-point indicator) outranks a server error, which outranks a
// pure timing/size deviation (weaker, more speculative signal on its own).
function severityFor(reasons) {
  if (reasons.includes('payload_reflected_unescaped')) return 'HIGH';
  if (reasons.includes('server_error')) return 'MEDIUM';
  return 'LOW';
}

function primaryReason(reasons) {
  return reasons.includes('payload_reflected_unescaped') ? 'payload_reflected_unescaped'
    : reasons.includes('server_error') ? 'server_error'
    : reasons.includes('response_size_deviation') ? 'response_size_deviation'
    : 'latency_deviation';
}

export function normalizeHttpFuzz(rawPayload) {
  const probes = Array.isArray(rawPayload?.raw) ? rawPayload.raw : [];
  return probes
    .filter((probe) => probe?.type === 'HTTP_FUZZ_PROBE' && probe.anomalous === true && probe.anomalyReasons?.length > 0)
    .map((probe) => {
      const reason = primaryReason(probe.anomalyReasons);
      return {
        category: 'INPUT_ROBUSTNESS',
        capabilityId: 'FUZZ',
        ruleId: REASON_RULE_IDS[reason],
        title: REASON_TITLES[reason],
        description: `A bounded BCI Smart Fuzz ${probe.source === 'AI_ADAPTIVE' ? 'AI-adaptive' : probe.source === 'USER' ? 'user-selected' : 'base'} probe (${probe.category}) against ${probe.method} ${probe.endpoint} produced: ${probe.anomalyReasons.join(', ')}.`,
        engineSeverity: severityFor(probe.anomalyReasons),
        cveIds: [],
        cweIds: [],
        location: `${probe.location || 'query'}:${probe.parameter}`,
        evidence: {
          capability: 'FUZZ',
          method: probe.method,
          endpoint: probe.endpoint,
          parameter: probe.parameter,
          location: probe.location,
          category: probe.category,
          // BASE (BCI's own guaranteed coverage) vs AI_ADAPTIVE (an
          // AI-proposed follow-up round layered on top) -- kept distinct
          // in provenance, never merged into one undifferentiated source.
          source: probe.source === 'AI_ADAPTIVE' ? 'AI_ADAPTIVE' : probe.source === 'USER' ? 'USER' : 'BASE',
          httpStatus: probe.status,
          baselineStatus: probe.baselineStatus,
          sizeBytes: probe.sizeBytes,
          baselineSizeBytes: probe.baselineSizeBytes,
          timeMs: probe.timeMs,
          baselineTimeMs: probe.baselineTimeMs,
          reflected: probe.reflected,
          anomalyReasons: probe.anomalyReasons,
        },
        references: [],
      };
    });
}
