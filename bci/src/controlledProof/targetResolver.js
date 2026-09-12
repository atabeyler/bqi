import { curlFetch } from '../engines/adapters/nativeHttp.js';

const MAX_CANONICAL_REDIRECTS = 3;

function siteKey(hostname) {
  return String(hostname || '').toLowerCase().replace(/^www\./, '');
}

export function isSafeCanonicalRedirect(from, to) {
  const portCompatible = to.port === from.port || (!to.port && !from.port);
  return ['http:', 'https:'].includes(to.protocol)
    && siteKey(from.hostname) === siteKey(to.hostname)
    && !(from.protocol === 'https:' && to.protocol === 'http:')
    && portCompatible
    && !to.username && !to.password;
}

export async function resolveCanonicalProofTarget(target, { timeoutMs = 7_000, signal } = {}) {
  let current = new URL(target);
  const redirects = [];
  let terminalResponse = null;
  for (let index = 0; index < MAX_CANONICAL_REDIRECTS; index += 1) {
    const response = await curlFetch(current.toString(), { method: 'GET', followRedirects: false, timeoutMs, signal });
    terminalResponse = response;
    const location = response.headers.location;
    if (response.status < 300 || response.status >= 400 || !location) break;
    const next = new URL(location, current);
    if (!isSafeCanonicalRedirect(current, next)) {
      redirects.push({ from: current.toString(), status: response.status, accepted: false, reason: 'CROSS_SITE_OR_DOWNGRADE_REDIRECT' });
      break;
    }
    redirects.push({ from: current.toString(), to: next.toString(), status: response.status, accepted: true });
    current = next;
  }
  return { target: current.toString(), redirects, response: terminalResponse };
}
