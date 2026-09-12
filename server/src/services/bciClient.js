/**
 * BCI Gateway client.
 * -------------------
 * BCI (BOLD Cyber Intelligence) is a separate, independently deployed
 * product (see bci/) with its own database, users, and RBAC -- BQI
 * never reads BCI's database directly and never shares its own JWT_SECRET
 * with it. The only integration point is BCI's HTTP API, reached
 * server-to-server (this file), never from the browser: the client only
 * ever calls BQI's own /api/cyber-analysis/* routes (see
 * routes/cyberAnalysis.js), which proxy through here.
 *
 * Trust flow: this signs a short-lived "gateway token" asserting the
 * calling BQI user's identity and role, using BCI_GATEWAY_SECRET --
 * a secret shared with BCI for exactly this purpose and distinct from
 * either side's own session-signing secret. BCI verifies that token,
 * provisions/looks up a corresponding BCI user under a dedicated
 * "bqi" organization, and returns a normal BCI access token scoped
 * to that user's real BCI role -- BQI never gets to assert BCI
 * permissions directly, only identity.
 */
import jwt from 'jsonwebtoken';
import { logger } from '../lib/logger.js';
import { ROLES, resolveRole } from '../lib/rbac.js';

const BCI_BASE_URL = process.env.BCI_BASE_URL;
const BCI_GATEWAY_SECRET = process.env.BCI_GATEWAY_SECRET;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export function isBciConfigured() {
  return Boolean(BCI_BASE_URL && BCI_GATEWAY_SECRET);
}

// BQI's 3-role model maps onto BCI's 6-role catalog at the
// least-privilege end unless the BQI user is an admin -- BCI's own
// RBAC (bci/src/lib/rbac.js) still enforces every permission independently
// on its side; this mapping only decides which BCI role gets provisioned.
function mapBQIRoleToBci(bqiRole) {
  // BQI's administrator is the only integrated identity allowed to
  // perform BCI system administration (engine health and Quantum policy).
  // Mapping it to security_admin left those admin-only UI controls visible
  // but guaranteed every save would fail with system:manage forbidden.
  if (bqiRole === ROLES.ADMIN) return 'system_admin';
  if (bqiRole === ROLES.ANALYST) return 'analyst';
  return 'viewer';
}

// Cached per BQI user for a little under BCI's own token lifetime,
// so a page that fires several Cyber Analysis requests in a row doesn't
// mint a fresh BCI session (and provision a BCI user) on every single one.
const tokenCache = new Map(); // userCode -> { token, expiresAt }
const tokenRequests = new Map(); // userCode -> in-flight gateway session promise
const TOKEN_CACHE_MS = 10 * 60 * 1000;

async function getBciToken(user) {
  const cached = tokenCache.get(user.userCode);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  // A BCI screen loads several resources concurrently. Without single-flight
  // protection every one of those requests created its own gateway session on
  // the first visit; provisioning the same user concurrently could make one or
  // more calls fail even though a refresh immediately worked. All callers for
  // one user now share the same real gateway handshake.
  const pending = tokenRequests.get(user.userCode);
  if (pending) return pending;

  const request = createBciToken(user).finally(() => tokenRequests.delete(user.userCode));
  tokenRequests.set(user.userCode, request);
  return request;
}

async function createBciToken(user) {

  const gatewayToken = jwt.sign(
    { sub: user.userCode, email: `${user.userCode}@bqi.local`, role: mapBQIRoleToBci(resolveRole(user)) },
    BCI_GATEWAY_SECRET,
    { expiresIn: '5m' }
  );

  const res = await fetch(`${BCI_BASE_URL}/api/v1/gateway/session`, {
    method: 'POST',
    headers: { authorization: `Bearer ${gatewayToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`BCI gateway session failed: HTTP ${res.status}`);
  const { token } = await res.json();

  tokenCache.set(user.userCode, { token, expiresAt: Date.now() + TOKEN_CACHE_MS });
  return token;
}

/**
 * Calls a BCI API endpoint on behalf of an authenticated BQI user.
 * Never throws for "BCI is down or misconfigured" -- returns
 * { ok: false, reason } instead, so a BCI outage degrades the Cyber
 * Analysis module without taking any BQI request down with it
 * (spec section 62's failure-design principle applied at this boundary).
 */
export async function callBci(user, path, { method = 'GET', body, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  if (!isBciConfigured()) {
    return { ok: false, reason: 'bci_not_configured' };
  }

  try {
    const token = await getBciToken(user);
    const res = await fetch(`${BCI_BASE_URL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, reason: 'bci_error', status: res.status, data };
    }
    return { ok: true, data };
  } catch (err) {
    logger.warn({ err, path }, 'BCI gateway call failed');
    return { ok: false, reason: 'bci_unreachable' };
  }
}
