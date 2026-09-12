/**
 * httpOnly session-cookie helpers for the web client. Desktop (Electron)
 * and mobile (Capacitor) never use these -- they call the deployed API from
 * a different origin (see client/src/services/api.js's baseFor()), so a
 * cookie set by the API origin wouldn't reach them anyway; those platforms
 * keep authenticating with an explicit `Authorization: Bearer` header,
 * unchanged (see middleware/auth.js accepting either).
 */
export const AUTH_COOKIE_NAME = 'bqi_jwt';

const isProd = process.env.NODE_ENV === 'production';

export function setAuthCookie(res, token, maxAgeMs) {
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd,
    // 'lax' (not 'strict') so the cookie still rides along on a same-site
    // top-level navigation (e.g. a report download link opened in a new
    // tab), while still being withheld from cross-site POST/fetch, which is
    // the actual CSRF attack shape this needs to block.
    sameSite: 'lax',
    maxAge: maxAgeMs,
    path: '/',
  });
}

export function clearAuthCookie(res) {
  res.clearCookie(AUTH_COOKIE_NAME, { httpOnly: true, secure: isProd, sameSite: 'lax', path: '/' });
}

// Manual parse instead of the cookie-parser package: only ever reads this
// one cookie, and Socket.IO's handshake never runs through Express
// middleware at all, so it needs raw header parsing either way -- adding a
// dependency for the two Express routes that also want it isn't worth it.
export function readCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

export function readAuthCookie(cookieHeader) {
  return readCookie(cookieHeader, AUTH_COOKIE_NAME);
}
