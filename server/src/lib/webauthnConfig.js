/**
 * WebAuthn Relying Party identity. RP ID must be the app's registrable
 * domain (no scheme/port) and must match what the browser sends as the
 * credential's origin, or every ceremony fails closed -- see
 * @simplewebauthn/server's origin/rpID checks in routes/webauthn.js.
 *
 * Defaults are derived from APP_URL (already required for the existing
 * mail-approval links, see routes/auth.js) so a correctly configured
 * deployment needs no extra env vars; WEBAUTHN_RP_ID/WEBAUTHN_ORIGIN(S) are
 * only for when the public origin differs from APP_URL (e.g. a CDN/proxy
 * front door) or for local dev against a non-localhost hostname.
 */
const APP_URL = process.env.APP_URL || 'http://localhost:10000';

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'localhost';
  }
}

export const RP_NAME = process.env.WEBAUTHN_RP_NAME || 'BQI';
export const RP_ID = process.env.WEBAUTHN_RP_ID || hostnameOf(APP_URL);

// Comma-separated list of origins allowed to complete a ceremony -- lets a
// single RP_ID (e.g. "bqi.example.com") serve both the web app and,
// if ever needed, a same-domain PWA/desktop shell origin. Falls back to the
// single APP_URL origin.
export const EXPECTED_ORIGINS = (process.env.WEBAUTHN_ORIGINS || APP_URL)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
