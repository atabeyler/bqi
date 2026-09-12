import { curlFetch } from '../../engines/adapters/nativeHttp.js';
import { sha256 } from '../core.js';

const SUPPORTED_CONTENT_TYPE = /^(?:text\/html|application\/xhtml\+xml|text\/plain)(?:;|$)/i;
const MAX_CANDIDATES = 5;
const SAFE_SYNTHETIC_PARAMETER = 'bci_probe';

function eligibleCandidates(endpoints) {
  const candidates = [];
  for (const endpoint of endpoints) {
    if (!endpoint.executable || endpoint.method !== 'GET') continue;
    const queryParameters = endpoint.params.filter((parameter) => parameter.location === 'query');
    if (queryParameters.length === 0) {
      candidates.push({ endpoint: endpoint.url, parameter: SAFE_SYNTHETIC_PARAMETER, source: `${endpoint.source}:bounded_synthetic_query` });
      if (candidates.length === MAX_CANDIDATES) return candidates;
    }
    for (const parameter of queryParameters) {
      candidates.push({ endpoint: endpoint.url, parameter: parameter.name, source: endpoint.source });
      if (candidates.length === MAX_CANDIDATES) return candidates;
    }
  }
  return candidates;
}

function markerRequestUrl(endpoint, parameter, marker) {
  const url = new URL(endpoint);
  url.searchParams.set(parameter, marker);
  return url.toString();
}

function responseEvidence({ baseline, response, marker, endpoint, parameter }) {
  return {
    request: { method: 'GET', endpoint, parameter },
    response: {
      status: response.status,
      contentType: response.headers['content-type'] || null,
      sizeBytes: response.sizeBytes,
      timeMs: response.timeMs,
      bodyHash: sha256(response.body),
      baselineBodyHash: sha256(baseline.body),
      markerHash: sha256(marker),
      markerOffset: response.body.indexOf(marker),
    },
  };
}

export const responseReflectionValidator = {
  id: 'response-reflection',
  status: 'IMPLEMENTED',
  capability: 'SECURITY_IMPACT_VALIDATION',
  persistentModification: false,

  candidates: eligibleCandidates,

  async validate({ candidate, marker, timeoutMs = 7_000, signal }) {
    const baseline = await curlFetch(candidate.endpoint, { method: 'GET', followRedirects: false, timeoutMs, signal });
    const response = await curlFetch(markerRequestUrl(candidate.endpoint, candidate.parameter, marker), { method: 'GET', followRedirects: false, timeoutMs, signal });
    const contentType = response.headers['content-type'] || '';
    const exactMarkerObserved = !baseline.body.includes(marker) && response.body.includes(marker);
    const verified = response.status >= 200 && response.status < 400 && SUPPORTED_CONTENT_TYPE.test(contentType) && exactMarkerObserved;
    return {
      verified,
      reason: verified ? null : 'exact_marker_not_observed_in_supported_response',
      evidence: responseEvidence({ baseline, response, marker, endpoint: candidate.endpoint, parameter: candidate.parameter }),
    };
  },
};
