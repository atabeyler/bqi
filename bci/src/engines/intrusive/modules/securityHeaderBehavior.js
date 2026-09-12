import { curlFetch } from '../../adapters/nativeHttp.js';
import { buildRecord, errorRecord } from '../recordHelpers.js';

const FAMILY = 'SECURITY_HEADER_BEHAVIOR';
const SECURITY_HEADERS = ['x-frame-options', 'content-security-policy', 'x-content-type-options'];
// Version banner patterns -- deliberately narrow (digits after a known
// server token) so this doesn't flag every "Server: nginx" (a bare
// product name, not itself a disclosed exact version).
const VERSION_BANNER = /\/[0-9]+\.[0-9]+/;

// Distinct from Nuclei's static per-header templates (missing-csp.yaml
// etc., SAFE_ACTIVE): this validates BEHAVIOR -- whether security headers
// present on a normal response are still present (or silently dropped) on
// an error-path response, and whether Server/X-Powered-By discloses an
// exact version banner. A real, differential check, not a duplicate.
export const securityHeaderBehaviorModule = {
  id: 'SECURITY_HEADER_BEHAVIOR',
  family: FAMILY,
  name: 'Security Header Behavior Validation',
  description: 'Compares security headers between a normal and an error-path response, and checks for version banner disclosure.',
  status: 'IMPLEMENTED',
  requiredIntrusiveness: 'RESTRICTED',
  isApplicable: () => true,

  async run({ target, timeoutMs, headers = [], roundNumber = 1 }) {
    const records = [];
    let baselineResult;
    try {
      baselineResult = await curlFetch(target, { method: 'GET', headers, timeoutMs });
    } catch (err) {
      records.push(errorRecord({ moduleId: this.id, family: FAMILY, target, testType: 'HEADER_DROP_ON_ERROR_PATH', error: err, roundNumber }));
    }

    if (baselineResult) {
      let errorPathUrl;
      try { errorPathUrl = new URL('/bci-intrusive-nonexistent-path-probe', target).toString(); } catch { errorPathUrl = target; }
      try {
        const errorResult = await curlFetch(errorPathUrl, { method: 'GET', headers, timeoutMs });
        const droppedHeaders = SECURITY_HEADERS.filter((h) => baselineResult.headers[h] && !errorResult.headers[h]);
        records.push(buildRecord({
          moduleId: this.id, family: FAMILY, target, endpoint: errorPathUrl, testType: 'HEADER_DROP_ON_ERROR_PATH',
          baseline: { headersPresent: SECURITY_HEADERS.filter((h) => baselineResult.headers[h]) },
          observed: { headersPresent: SECURITY_HEADERS.filter((h) => errorResult.headers[h]), status: errorResult.status },
          evidence: { droppedHeaders, baselineStatus: baselineResult.status, errorStatus: errorResult.status },
          verificationStatus: 'VERIFIED', roundNumber,
          anomalous: droppedHeaders.length > 0, anomalyReasons: droppedHeaders.length > 0 ? ['security_headers_dropped_on_error_path'] : [],
        }));
      } catch (err) {
        records.push(errorRecord({ moduleId: this.id, family: FAMILY, target, testType: 'HEADER_DROP_ON_ERROR_PATH', error: err, roundNumber }));
      }

      const serverBanner = baselineResult.headers['server'];
      const poweredBy = baselineResult.headers['x-powered-by'];
      const disclosed = [serverBanner, poweredBy].filter((v) => v && VERSION_BANNER.test(v));
      records.push(buildRecord({
        moduleId: this.id, family: FAMILY, target, testType: 'VERSION_BANNER_DISCLOSURE',
        baseline: null, observed: { server: serverBanner ?? null, xPoweredBy: poweredBy ?? null },
        evidence: { server: serverBanner ?? null, xPoweredBy: poweredBy ?? null },
        verificationStatus: 'VERIFIED', roundNumber,
        anomalous: disclosed.length > 0, anomalyReasons: disclosed.length > 0 ? ['version_banner_disclosed'] : [],
      }));
    }

    return records;
  },
};
