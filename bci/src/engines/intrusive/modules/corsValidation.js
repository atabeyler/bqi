import { curlFetch } from '../../adapters/nativeHttp.js';
import { buildRecord, errorRecord } from '../recordHelpers.js';

const FAMILY = 'CORS_VALIDATION';
const UNTRUSTED_ORIGIN = 'https://bci-cors-probe.invalid';

// Real CORS misconfiguration validation: sends a request carrying an
// Origin header for a domain the target has no legitimate reason to
// trust, and inspects whether the server reflects it back in
// Access-Control-Allow-Origin -- especially combined with
// Access-Control-Allow-Credentials: true, which together mean any
// third-party site can read authenticated responses from this target on
// a victim's behalf. Purely observational (GET); never attempts an
// actual cross-origin exploit.
export const corsValidationModule = {
  id: 'CORS_VALIDATION',
  family: FAMILY,
  name: 'CORS Validation',
  description: 'Validates Access-Control-Allow-Origin/Allow-Credentials behavior against an untrusted Origin.',
  status: 'IMPLEMENTED',
  requiredIntrusiveness: 'RESTRICTED',
  isApplicable: () => true,

  async run({ target, timeoutMs, headers = [], roundNumber = 1 }) {
    try {
      const result = await curlFetch(target, { method: 'GET', headers: [...headers, `Origin: ${UNTRUSTED_ORIGIN}`], timeoutMs });
      const allowOrigin = result.headers['access-control-allow-origin'];
      const allowCredentials = result.headers['access-control-allow-credentials'];
      const reflectsUntrustedOrigin = allowOrigin === UNTRUSTED_ORIGIN || allowOrigin === '*';
      const credentialedReflection = reflectsUntrustedOrigin && allowOrigin === UNTRUSTED_ORIGIN && allowCredentials === 'true';

      const reasons = [];
      if (credentialedReflection) reasons.push('cors_credentialed_origin_reflection');
      else if (reflectsUntrustedOrigin) reasons.push('cors_permissive_origin');

      return [buildRecord({
        moduleId: this.id, family: FAMILY, target, testType: 'UNTRUSTED_ORIGIN_REFLECTION',
        baseline: { header: 'Access-Control-Allow-Origin', expectedAbsentOrScoped: true },
        observed: { allowOrigin: allowOrigin ?? null, allowCredentials: allowCredentials ?? null },
        evidence: { requestOrigin: UNTRUSTED_ORIGIN, allowOrigin: allowOrigin ?? null, allowCredentials: allowCredentials ?? null, httpStatus: result.status },
        verificationStatus: 'VERIFIED', roundNumber,
        anomalous: reasons.length > 0, anomalyReasons: reasons,
      })];
    } catch (err) {
      return [errorRecord({ moduleId: this.id, family: FAMILY, target, testType: 'UNTRUSTED_ORIGIN_REFLECTION', error: err, roundNumber })];
    }
  },
};
