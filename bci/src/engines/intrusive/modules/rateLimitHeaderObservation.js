import { curlFetch } from '../../adapters/nativeHttp.js';
import { buildRecord, errorRecord } from '../recordHelpers.js';

const FAMILY = 'RATE_LIMIT_THROTTLING_BEHAVIOR';
const RATE_LIMIT_HEADERS = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'retry-after', 'ratelimit-limit'];

// Deliberately PASSIVE/observational, exactly two ordinary sequential
// requests -- this is NOT a burst/load test. Rate-limit/throttling
// BEHAVIOR under real load is the availability-probe adapter's job (the
// DOS capability), kept as its own separate capability per spec; this
// module only checks whether the target advertises rate-limit headers at
// all, and whether the remaining-quota value (if present) actually
// decreases between two ordinary requests -- real evidence the mechanism
// is live, without ever attempting to trigger or exhaust it.
export const rateLimitHeaderObservationModule = {
  id: 'RATE_LIMIT_HEADER_OBSERVATION',
  family: FAMILY,
  name: 'Rate-Limit / Throttling Header Observation',
  description: 'Passively observes rate-limit headers across two ordinary requests -- never a burst/load test (see the separate DOS capability for that).',
  status: 'IMPLEMENTED',
  requiredIntrusiveness: 'RESTRICTED',
  isApplicable: () => true,

  async run({ target, timeoutMs, headers = [], roundNumber = 1 }) {
    try {
      const first = await curlFetch(target, { method: 'GET', headers, timeoutMs });
      const second = await curlFetch(target, { method: 'GET', headers, timeoutMs });
      const advertised = RATE_LIMIT_HEADERS.filter((h) => first.headers[h] != null);
      const remainingBefore = Number(first.headers['x-ratelimit-remaining']);
      const remainingAfter = Number(second.headers['x-ratelimit-remaining']);
      const quotaDecreasing = Number.isFinite(remainingBefore) && Number.isFinite(remainingAfter) && remainingAfter < remainingBefore;

      return [buildRecord({
        moduleId: this.id, family: FAMILY, target, testType: 'RATE_LIMIT_HEADERS_PRESENT',
        baseline: null,
        observed: { advertisedHeaders: advertised, remainingBefore: Number.isFinite(remainingBefore) ? remainingBefore : null, remainingAfter: Number.isFinite(remainingAfter) ? remainingAfter : null },
        evidence: { advertisedHeaders: advertised, quotaDecreasing },
        // "advertises no rate limiting" is a real, reportable OBSERVATION
        // (worth an admin knowing), not an anomaly/vulnerability in itself
        // -- many legitimate services simply don't expose these headers.
        verificationStatus: 'VERIFIED', roundNumber,
        anomalous: false, anomalyReasons: [],
      })];
    } catch (err) {
      return [errorRecord({ moduleId: this.id, family: FAMILY, target, testType: 'RATE_LIMIT_HEADERS_PRESENT', error: err, roundNumber })];
    }
  },
};
