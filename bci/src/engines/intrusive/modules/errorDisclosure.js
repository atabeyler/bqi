import { curlFetch } from '../../adapters/nativeHttp.js';
import { buildRecord, errorRecord } from '../recordHelpers.js';

const FAMILY = 'ERROR_DISCLOSURE';

// A real, bounded set of markers that indicate a raw stack trace, debug
// page, or backend error leaked into a response body -- never guessed,
// always a literal, well-known fragment specific to a real error-page
// format. Kept small and specific deliberately: broad substrings (e.g.
// "error") would false-positive on completely normal pages.
const DISCLOSURE_MARKERS = [
  { pattern: /Traceback \(most recent call last\)/, label: 'python_traceback' },
  { pattern: /at [\w$.]+\s*\([^)]*\.(js|ts):\d+:\d+\)/, label: 'node_stack_trace' },
  { pattern: /Exception in thread|java\.lang\.\w+Exception/, label: 'java_stack_trace' },
  { pattern: /Fatal error: Uncaught|Stack trace:\s*\n#0/, label: 'php_stack_trace' },
  { pattern: /System\.\w+Exception:/, label: 'dotnet_stack_trace' },
  { pattern: /Whitelabel Error Page|org\.springframework/, label: 'spring_error_page' },
  { pattern: /Django Version:.*Exception Type:/s, label: 'django_debug_page' },
  { pattern: /You have an error in your SQL syntax/, label: 'sql_error_leak' },
];

// Requests a real nonexistent path and inspects the actual response body
// for well-known error/stack-trace/debug-page fragments -- real evidence
// of information disclosure, never inferred from status code alone (a
// clean, generic 404/500 page is not a finding).
export const errorDisclosureModule = {
  id: 'ERROR_DISCLOSURE',
  family: FAMILY,
  name: 'Error Handling / Information Disclosure Validation',
  description: 'Requests a nonexistent path and inspects the real response body for stack traces or debug-page fragments.',
  status: 'IMPLEMENTED',
  requiredIntrusiveness: 'RESTRICTED',
  isApplicable: () => true,

  async run({ target, timeoutMs, headers = [], roundNumber = 1 }) {
    let errorPathUrl;
    try { errorPathUrl = new URL('/bci-intrusive-nonexistent-path-probe-x9f2', target).toString(); } catch { errorPathUrl = target; }
    try {
      const result = await curlFetch(errorPathUrl, { method: 'GET', headers, timeoutMs });
      const matched = DISCLOSURE_MARKERS.filter((m) => m.pattern.test(result.body)).map((m) => m.label);
      return [buildRecord({
        moduleId: this.id, family: FAMILY, target, endpoint: errorPathUrl, testType: 'STACK_TRACE_DISCLOSURE',
        baseline: { expectedGenericErrorPage: true },
        observed: { status: result.status, bodySizeBytes: result.sizeBytes, matchedMarkers: matched },
        evidence: { httpStatus: result.status, matchedMarkers: matched },
        verificationStatus: 'VERIFIED', roundNumber,
        anomalous: matched.length > 0, anomalyReasons: matched.length > 0 ? ['information_disclosure_in_error_response'] : [],
      })];
    } catch (err) {
      return [errorRecord({ moduleId: this.id, family: FAMILY, target, endpoint: errorPathUrl, testType: 'STACK_TRACE_DISCLOSURE', error: err, roundNumber })];
    }
  },
};
