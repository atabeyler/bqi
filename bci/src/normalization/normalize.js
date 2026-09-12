import { normalizeTrivy } from './normalizers/trivy.js';
import { normalizeOsvScanner } from './normalizers/osvScanner.js';
import { normalizeSemgrep } from './normalizers/semgrep.js';
import { normalizeNuclei } from './normalizers/nuclei.js';
import { normalizeNaabu } from './normalizers/naabu.js';
import { normalizeHttpFuzz } from './normalizers/httpFuzz.js';
import { normalizeIntrusiveValidation } from './normalizers/intrusiveValidation.js';
import { normalizeAvailabilityProbe } from './normalizers/availabilityProbe.js';
import { normalizePostureIntelligence } from './normalizers/postureIntelligence.js';
const NORMALIZERS = {
  trivy: normalizeTrivy, 'osv-scanner': normalizeOsvScanner, semgrep: normalizeSemgrep,
  nuclei: normalizeNuclei, naabu: normalizeNaabu, 'http-fuzz': normalizeHttpFuzz,
  'intrusive-validation': normalizeIntrusiveValidation, 'availability-probe': normalizeAvailabilityProbe,
  'bci-posture-intelligence': normalizePostureIntelligence,
};
export function normalizeRaw(engineId, rawPayload) {
  const normalizer = NORMALIZERS[engineId];
  if (!normalizer) throw new Error(`No normalizer registered for engine "${engineId}"`);
  const binaryEnvelope = ['trivy', 'osv-scanner', 'semgrep', 'nuclei', 'naabu'].includes(engineId)
    && rawPayload && typeof rawPayload === 'object' && Object.hasOwn(rawPayload, 'raw');
  return normalizer(binaryEnvelope ? rawPayload.raw : rawPayload);
}
export function supportsEngine(engineId) { return Object.prototype.hasOwnProperty.call(NORMALIZERS, engineId); }
