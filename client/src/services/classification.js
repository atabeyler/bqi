// Client-side mirror of server/src/services/decisionIntelligence.js's
// classifyData() category-floor table (PUBLIC/INTERNAL/CONFIDENTIAL/
// RESTRICTED). This is informational only -- the server recomputes and
// enforces the real floor on every write via classifyData() itself, and a
// value sent from here can only ever raise what the server would have
// derived from category alone, never lower it. Its purpose is narrower:
// letting the UI tell an upload (api.uploadForAI) or a generation request
// (api.generateAnalysis) which classification it's about to belong to,
// so a CONFIDENTIAL/RESTRICTED-category analysis's attachments are scanned
// under that classification's fail-closed policy (see lib/fileScan.js)
// instead of silently defaulting to INTERNAL just because the client never
// said otherwise.
const HIGH_SENSITIVITY_CATEGORIES = new Set(['savunma', 'saldiri', 'bddk', 'btk', 'cok-alanli']);

export function classifyCategory(category) {
  if (HIGH_SENSITIVITY_CATEGORIES.has(category)) return 'CONFIDENTIAL';
  return category ? 'INTERNAL' : null;
}
