// naabu findings ("port open") are the one adapter output that isn't a
// vulnerability at all, just an attack-surface fact -- category
// NETWORK_DISCOVERY marks that distinction through to Correlation/Risk.
export function normalizeNaabu(rawLines) {
  return (rawLines || []).map((entry) => ({
    category: 'NETWORK_DISCOVERY',
    capabilityId: 'NETWORK_DISCOVERY',
    ruleId: 'open-port',
    title: `Open port ${entry.port}/${entry.protocol}`,
    description: `Host ${entry.ip} has an open ${entry.protocol} port ${entry.port}${entry.tls ? ' (TLS)' : ''}.`,
    engineSeverity: 'info',
    location: `${entry.ip}:${entry.port}`,
    evidence: { protocol: entry.protocol, tls: !!entry.tls },
    references: [],
  }));
}
