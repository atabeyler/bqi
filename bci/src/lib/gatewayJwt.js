import jwt from 'jsonwebtoken';
import { config } from '../config.js';

// Verifies a token signed by an external gateway (BQI today) with
// BCI_GATEWAY_SECRET -- a secret distinct from BCI's own jwtSecret, so this
// function's trust and the normal user-session trust never share a key.
// Fails closed: an unconfigured secret means every gateway token is
// rejected, never accepted-by-default.
export function verifyGatewayToken(token) {
  if (!config.gatewaySecret) {
    throw new Error('BCI_GATEWAY_SECRET is not configured');
  }
  const payload = jwt.verify(token, config.gatewaySecret);
  if (!payload.sub || !payload.email) {
    throw new Error('gateway token missing required claims (sub, email)');
  }
  return { externalId: payload.sub, email: payload.email, role: payload.role };
}
