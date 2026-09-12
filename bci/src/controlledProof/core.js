import { createHash, randomBytes } from 'node:crypto';

export const CONTROLLED_PROOF_ENGINE_ID = 'controlled-proof';
export const CONTROLLED_PROOF_ENGINE_VERSION = '1.4.1';
export const ANALYSIS_RESULT = Object.freeze({
  NO_PATH: 'NO_PATH',
  POTENTIAL: 'POTENTIAL',
  VERIFIED_IMPACT_PATH: 'VERIFIED_IMPACT_PATH',
});

export function classifyAnalysisResult({ verified = false, hasPotentialSignals = false } = {}) {
  if (verified) return ANALYSIS_RESULT.VERIFIED_IMPACT_PATH;
  return hasPotentialSignals ? ANALYSIS_RESULT.POTENTIAL : ANALYSIS_RESULT.NO_PATH;
}

export function normalizeProofTarget(rawTarget) {
  if (typeof rawTarget !== 'string' || rawTarget.length === 0 || rawTarget.length > 2048) {
    throw new TypeError('invalid_target');
  }
  let url;
  try {
    url = new URL(rawTarget);
  } catch {
    throw new TypeError('invalid_target');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new TypeError('invalid_target');
  }
  url.hash = '';
  return url.toString();
}

export function generateProofId() {
  return randomBytes(16).toString('hex').toUpperCase();
}

export function buildValidationToken(proofId, now = new Date()) {
  if (!/^[A-F0-9]{32}$/.test(proofId)) throw new TypeError('invalid_proof_id');
  return `BCI VALIDATION · ${proofId} · ${now.toISOString().slice(11, 19)}`;
}

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}
