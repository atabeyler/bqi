function extractCweId(cweEntry) {
  // Semgrep metadata.cwe entries look like "CWE-95: Improper Neutralization
  // of Directives in Dynamically Evaluated Code" -- keep just the id.
  return cweEntry?.match(/^CWE-\d+/)?.[0];
}

export function normalizeSemgrep(raw) {
  return (raw.results || []).map((r) => ({
    category: 'SAST',
    capabilityId: 'SAST',
    ruleId: r.check_id,
    title: r.check_id,
    description: r.extra?.message,
    engineSeverity: r.extra?.severity,
    cweIds: (r.extra?.metadata?.cwe || []).map(extractCweId).filter(Boolean),
    location: `${r.path}:${r.start?.line}`,
    evidence: { startLine: r.start?.line, endLine: r.end?.line },
    references: r.extra?.metadata?.references || [],
  }));
}
