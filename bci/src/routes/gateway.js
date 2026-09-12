import { Router } from 'express';
import { verifyGatewayToken } from '../lib/gatewayJwt.js';
import { getOrCreateGatewayOrg, getOrCreateShadowUser } from '../services/gatewayProvisioning.js';
import { signAccessToken } from '../lib/jwt.js';
import { config } from '../config.js';
import { recordAuditEvent } from '../services/audit.js';

export const gatewayRouter = Router();

// This IS the auth entry point for a trusted external gateway (BQI
// today) -- it deliberately does not sit behind requireAuth. Trust comes
// entirely from BCI_GATEWAY_SECRET verifying the caller's token; an
// unconfigured secret means verifyGatewayToken() throws for every request
// (fail closed), never falls back to accepting unsigned assertions.
gatewayRouter.post('/session', async (req, res) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'missing_gateway_token' });
  }

  let identity;
  try {
    identity = verifyGatewayToken(token);
  } catch {
    return res.status(401).json({ error: 'invalid_gateway_token' });
  }

  const orgId = await getOrCreateGatewayOrg();
  const userId = await getOrCreateShadowUser(orgId, identity);
  const accessToken = signAccessToken({ userId, orgId, ttlSeconds: config.gatewaySessionTtlSeconds });

  await recordAuditEvent({
    orgId,
    actorUserId: userId,
    action: 'gateway.session_issued',
    result: 'SUCCESS',
    metadata: { externalId: identity.externalId, role: identity.role },
  });

  res.json({ token: accessToken, expiresIn: config.gatewaySessionTtlSeconds });
});
