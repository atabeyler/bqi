import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../lib/jwtSecret.js';
import { readAuthCookie } from '../lib/cookies.js';
import { isUserBlocked } from '../lib/blockedUserCache.js';

// Accepts either an httpOnly session cookie (web) or an `Authorization:
// Bearer` header (desktop/mobile, which run from a different origin than
// the API and so never receive/send the cookie -- see lib/cookies.js).
// The cookie is checked first only because it's the more common case now;
// a request never legitimately carries both.
export async function authMiddleware(req, res, next) {
  const cookieToken = readAuthCookie(req.headers.cookie);
  const auth = req.headers.authorization;
  const headerToken = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  const token = cookieToken || headerToken;

  if (!token) {
    return res.status(401).json({ error: 'Yetkisiz' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token geçersiz' });
  }

  // jwt.verify only proves the token was validly issued and hasn't expired
  // -- it says nothing about whether the account has since been blocked by
  // an admin. Re-checking `blocked` here (via a short-TTL cache, not a raw
  // DB query on every request -- see lib/blockedUserCache.js) is what makes
  // a block take effect for API access within seconds instead of waiting
  // out the token's remaining lifetime (up to 4h for an admin token).
  if (await isUserBlocked(decoded.userCode)) {
    return res.status(403).json({ error: 'Hesabınız engellenmiş' });
  }

  req.user = decoded;
  // Stashed so a route that needs to forward the caller's identity to
  // another internal request (see routes/platform.js's replay endpoint)
  // can do so regardless of whether this request authenticated via
  // cookie or header.
  req.token = token;
  next();
}
