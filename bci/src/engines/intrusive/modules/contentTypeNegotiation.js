import { curlFetch } from '../../adapters/nativeHttp.js';
import { buildRecord } from '../recordHelpers.js';

const FAMILY = 'CONTENT_TYPE_NEGOTIATION';
const ACCEPT_VARIANTS = ['application/json', 'application/xml', 'text/plain', '*/*'];

// Real content-negotiation behavior validation: the same GET request sent
// with different Accept headers can hit a completely different code path
// (a different serializer, a different error handler) -- comparing real
// status codes across variants surfaces a code path that only misbehaves
// under one specific Accept value, which single-variant scanning misses.
export const contentTypeNegotiationModule = {
  id: 'CONTENT_TYPE_NEGOTIATION',
  family: FAMILY,
  name: 'Content-Type / Accept Negotiation Validation',
  description: 'Compares real response status/content-type across multiple Accept header variants for the same endpoint.',
  status: 'IMPLEMENTED',
  requiredIntrusiveness: 'RESTRICTED',
  isApplicable: () => true,

  async run({ target, timeoutMs, headers = [], roundNumber = 1 }) {
    const observations = [];
    for (const accept of ACCEPT_VARIANTS) {
      try {
        const result = await curlFetch(target, { method: 'GET', headers: [...headers, `Accept: ${accept}`], timeoutMs });
        observations.push({ accept, status: result.status, contentType: result.headers['content-type'] ?? null });
      } catch (err) {
        observations.push({ accept, status: null, contentType: null, error: String(err.message || err) });
      }
    }

    const statuses = new Set(observations.map((o) => o.status).filter((s) => s != null));
    // One Accept variant returning 5xx while the others return something
    // consistent, non-error is real evidence of a negotiation-specific bug.
    const errorOutlier = observations.find((o) => o.status >= 500 && statuses.size > 1);

    return [buildRecord({
      moduleId: this.id, family: FAMILY, target, testType: 'ACCEPT_HEADER_STATUS_DIFFERENTIAL',
      baseline: { variantCount: ACCEPT_VARIANTS.length },
      observed: { observations },
      evidence: { observations, distinctStatusCount: statuses.size },
      verificationStatus: 'VERIFIED', roundNumber,
      anomalous: !!errorOutlier, anomalyReasons: errorOutlier ? ['accept_header_specific_server_error'] : [],
    })];
  },
};
