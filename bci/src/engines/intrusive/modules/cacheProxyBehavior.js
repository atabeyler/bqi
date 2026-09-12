import { curlFetch } from '../../adapters/nativeHttp.js';
import { buildRecord, errorRecord } from '../recordHelpers.js';

const FAMILY = 'CACHE_PROXY_BEHAVIOR';

export const cacheProxyBehaviorModule = {
  id: 'CACHE_PROXY_BEHAVIOR', family: FAMILY, name: 'Cache / Proxy Behavior Validation',
  description: 'Compares real cache metadata on repeated GETs and a unique cache-key request without attempting cache poisoning.',
  status: 'IMPLEMENTED', requiredIntrusiveness: 'RESTRICTED', isApplicable: () => true,
  async run({ target, timeoutMs, headers = [], roundNumber = 1 }) {
    try {
      const first = await curlFetch(target, { headers, timeoutMs });
      const second = await curlFetch(target, { headers, timeoutMs });
      const unique = new URL(target); unique.searchParams.set('bci_cache_probe', String(Date.now()));
      const bypass = await curlFetch(unique.toString(), { headers: [...headers, 'Cache-Control: no-cache'], timeoutMs });
      const cacheControl = second.headers['cache-control'] || '';
      const age = Number(second.headers.age || 0);
      const cacheSignal = second.headers['x-cache'] || second.headers['cf-cache-status'] || null;
      const setCookie = !!second.headers['set-cookie'];
      const shared = age > 0 || /hit/i.test(cacheSignal || '');
      const publicCookieResponse = shared && setCookie && !/private|no-store/i.test(cacheControl);
      return [buildRecord({
        moduleId: this.id, family: FAMILY, target, endpoint: target, testType: 'SHARED_CACHE_METADATA',
        baseline: { status: first.status, sizeBytes: first.sizeBytes },
        observed: { repeatedStatus: second.status, bypassStatus: bypass.status, age, cacheSignal, cacheControl },
        evidence: { sharedCacheObserved: shared, setCookie, repeatedSizeBytes: second.sizeBytes, bypassSizeBytes: bypass.sizeBytes },
        verificationStatus: 'VERIFIED', roundNumber, anomalous: publicCookieResponse,
        anomalyReasons: publicCookieResponse ? ['shared_cache_serves_cookie_response_without_private_policy'] : [],
      })];
    } catch (err) {
      return [errorRecord({ moduleId: this.id, family: FAMILY, target, testType: 'SHARED_CACHE_METADATA', error: err, roundNumber })];
    }
  },
};
