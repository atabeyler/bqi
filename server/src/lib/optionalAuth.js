import jwt from 'jsonwebtoken';
import { JWT_SECRET } from './jwtSecret.js';
import { readAuthCookie } from './cookies.js';

/**
 * Best-effort user identification for endpoints that must stay reachable
 * without a login (e.g. the pre-login emergency center button) but still
 * want to attribute the action to a known user when a valid token is
 * present (cookie for web, Authorization header for desktop/mobile -- see
 * middleware/auth.js). Falls back to 'ANONİM' for missing/invalid/expired
 * tokens -- never throws.
 */
export function getOptionalUserCode(req) {
  const auth = req.headers.authorization;
  const token = readAuthCookie(req.headers.cookie) || (auth?.startsWith('Bearer ') ? auth.slice(7) : null);
  if (!token) return 'ANONİM';
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded.userCode || 'ANONİM';
  } catch {
    return 'ANONİM';
  }
}
