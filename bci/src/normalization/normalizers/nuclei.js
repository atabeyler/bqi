import { redactHttpText } from '../redact.js';

export function normalizeNuclei(rawLines) {
  return (rawLines || []).map((finding) => ({
    category: 'WEB',
    capabilityId: 'WEB',
    ruleId: finding['template-id'],
    title: finding.info?.name || finding['template-id'],
    description: finding.info?.description,
    engineSeverity: finding.info?.severity,
    location: finding['matched-at'] || finding.url,
    evidence: {
      request: redactHttpText(finding.request),
      response: redactHttpText(finding.response),
    },
    references: finding.info?.reference || [],
  }));
}
