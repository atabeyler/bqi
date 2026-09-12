import { curlFetch } from '../../adapters/nativeHttp.js';
import { buildRecord, errorRecord } from '../recordHelpers.js';

const FAMILY = 'HOST_ROUTING_VALIDATION';
const BOGUS_HOST = 'bci-intrusive-host-probe.invalid';

// Real Host-header handling validation: connects to the actual target
// (same IP/port) but overrides the Host header curl sends -- a real,
// well-known class of bug (password-reset-link poisoning, cache
// poisoning, virtual-host confusion) where an application trusts the
// client-supplied Host header for routing/link-generation instead of its
// own configuration. Purely observational: compares the real response to
// a normal request against the real response with the bogus Host.
export const hostRoutingValidationModule = {
  id: 'HOST_ROUTING_VALIDATION',
  family: FAMILY,
  name: 'Redirect / Host-Routing Validation',
  description: 'Compares real responses with and without a spoofed Host header to detect Host-header trust issues.',
  status: 'IMPLEMENTED',
  requiredIntrusiveness: 'RESTRICTED',
  isApplicable: () => true,

  async run({ target, timeoutMs, headers = [], roundNumber = 1 }) {
    let baseline;
    try {
      baseline = await curlFetch(target, { method: 'GET', headers, timeoutMs });
    } catch (err) {
      return [errorRecord({ moduleId: this.id, family: FAMILY, target, testType: 'BOGUS_HOST_HEADER_REFLECTION', error: err, roundNumber })];
    }
    try {
      const spoofed = await curlFetch(target, { method: 'GET', headers: [...headers, `Host: ${BOGUS_HOST}`], timeoutMs });
      // The bogus host reflected back in a Location redirect, or in the
      // response body itself, is real evidence the app trusts client-
      // supplied Host for link generation/routing.
      const reflectedInLocation = !!spoofed.headers['location'] && spoofed.headers['location'].includes(BOGUS_HOST);
      const reflectedInBody = spoofed.body.includes(BOGUS_HOST);
      const reasons = [];
      if (reflectedInLocation) reasons.push('host_header_reflected_in_redirect');
      if (reflectedInBody) reasons.push('host_header_reflected_in_body');

      return [buildRecord({
        moduleId: this.id, family: FAMILY, target, testType: 'BOGUS_HOST_HEADER_REFLECTION',
        baseline: { status: baseline.status, location: baseline.headers['location'] ?? null },
        observed: { status: spoofed.status, location: spoofed.headers['location'] ?? null },
        evidence: { bogusHost: BOGUS_HOST, reflectedInLocation, reflectedInBody, spoofedStatus: spoofed.status },
        verificationStatus: 'VERIFIED', roundNumber,
        anomalous: reasons.length > 0, anomalyReasons: reasons,
      })];
    } catch (err) {
      return [errorRecord({ moduleId: this.id, family: FAMILY, target, testType: 'BOGUS_HOST_HEADER_REFLECTION', error: err, roundNumber })];
    }
  },
};
