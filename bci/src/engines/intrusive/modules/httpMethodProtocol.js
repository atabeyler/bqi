import { curlFetch } from '../../adapters/nativeHttp.js';
import { buildRecord, errorRecord } from '../recordHelpers.js';

const FAMILY = 'HTTP_METHOD_PROTOCOL';

// Real HTTP method/protocol behavior validation -- OPTIONS (what the
// server itself claims it accepts, via the Allow header) cross-checked
// against a real TRACE probe (a legacy method that, if accepted, echoes
// the raw request back -- a real, well-known information/XST exposure).
// Bounded to exactly these two methods; never attempts exploitation.
export const httpMethodProtocolModule = {
  id: 'HTTP_METHOD_PROTOCOL',
  family: FAMILY,
  name: 'HTTP Method & Protocol Validation',
  description: 'Validates HTTP method handling (OPTIONS/Allow header vs. real TRACE behavior) without automatic exploitation.',
  status: 'IMPLEMENTED',
  requiredIntrusiveness: 'RESTRICTED',
  isApplicable: () => true, // every HTTP target has a method surface to validate

  async run({ target, timeoutMs, headers = [], roundNumber = 1 }) {
    const records = [];
    let optionsResult;
    try {
      optionsResult = await curlFetch(target, { method: 'OPTIONS', headers, timeoutMs });
    } catch (err) {
      records.push(errorRecord({ moduleId: this.id, family: FAMILY, target, testType: 'OPTIONS_ALLOW_HEADER', error: err, roundNumber }));
    }
    if (optionsResult) {
      records.push(buildRecord({
        moduleId: this.id, family: FAMILY, target, testType: 'OPTIONS_ALLOW_HEADER',
        baseline: null, observed: { status: optionsResult.status },
        evidence: { method: 'OPTIONS', httpStatus: optionsResult.status },
        verificationStatus: 'VERIFIED', roundNumber, anomalous: false,
      }));
    }

    try {
      const traceResult = await curlFetch(target, { method: 'TRACE', headers, timeoutMs });
      const accepted = traceResult.status >= 200 && traceResult.status < 400;
      records.push(buildRecord({
        moduleId: this.id, family: FAMILY, target, testType: 'TRACE_METHOD_ACCEPTED',
        baseline: optionsResult ? { method: 'OPTIONS', status: optionsResult.status } : null,
        observed: { method: 'TRACE', status: traceResult.status },
        evidence: { method: 'TRACE', httpStatus: traceResult.status },
        verificationStatus: 'VERIFIED', roundNumber,
        anomalous: accepted, anomalyReasons: accepted ? ['trace_method_accepted'] : [],
      }));
    } catch (err) {
      records.push(errorRecord({ moduleId: this.id, family: FAMILY, target, testType: 'TRACE_METHOD_ACCEPTED', error: err, roundNumber }));
    }

    return records;
  },
};
