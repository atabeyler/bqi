import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export function signAccessToken({ userId, orgId, ttlSeconds = config.jwtTtlSeconds }) {
  return jwt.sign({ sub: userId, org: orgId }, config.jwtSecret, {
    expiresIn: ttlSeconds,
  });
}

export function verifyAccessToken(token) {
  const payload = jwt.verify(token, config.jwtSecret);
  return { userId: payload.sub, orgId: payload.org };
}
