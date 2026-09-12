export function normalizePostureIntelligence(rawPayload) {
  return Array.isArray(rawPayload?.findings) ? rawPayload.findings : [];
}
