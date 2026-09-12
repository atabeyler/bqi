import { randomBytes } from 'node:crypto';
import { curlFetch } from '../../adapters/nativeHttp.js';
import { buildRecord, errorRecord } from '../recordHelpers.js';

const FAMILY = 'WEBSOCKET_API_PROTOCOL';

export const webSocketProtocolModule = {
  id: 'WEBSOCKET_API_PROTOCOL', family: FAMILY, name: 'WebSocket / Streaming API Protocol Validation',
  description: 'Performs a real RFC 6455 upgrade handshake with an untrusted Origin on explicitly WebSocket-like endpoints.',
  status: 'IMPLEMENTED', requiredIntrusiveness: 'RESTRICTED',
  isApplicable: ({ target }) => /(?:^|\/)(?:ws|websocket|socket)(?:\/|$)/i.test(new URL(target).pathname),
  async run({ target, timeoutMs, headers = [], roundNumber = 1 }) {
    const origin = 'https://bci-invalid-origin.example';
    try {
      const result = await curlFetch(target, { method: 'GET', timeoutMs, headers: [
        ...headers, 'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, `Origin: ${origin}`,
      ] });
      const accepted = result.status === 101;
      return [buildRecord({
        moduleId: this.id, family: FAMILY, target, testType: 'UNTRUSTED_ORIGIN_WEBSOCKET_HANDSHAKE',
        baseline: { expected: 'untrusted origin rejected' }, observed: { status: result.status, upgrade: result.headers.upgrade || null },
        evidence: { origin, connection: result.headers.connection || null }, verificationStatus: 'VERIFIED', roundNumber,
        anomalous: accepted, anomalyReasons: accepted ? ['websocket_accepts_untrusted_origin'] : [],
      })];
    } catch (err) {
      return [errorRecord({ moduleId: this.id, family: FAMILY, target, testType: 'UNTRUSTED_ORIGIN_WEBSOCKET_HANDSHAKE', error: err, roundNumber })];
    }
  },
};
