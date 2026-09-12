import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../lib/rbac.js';
import { runCryptoDiscovery, listCryptoFindings, discoverJwtAlgorithm, discoverCodeSigningCertificate } from '../services/cryptoDiscovery.js';
import { buildCbom } from '../services/cbom.js';
import { computeReadiness } from '../services/pqcReadiness.js';

export const cryptoRouter = Router();

cryptoRouter.use(requireAuth);

const discoverSchema = z.object({
  target: z.string().min(1),
  port: z.number().int().positive().max(65535).optional(),
  protocol: z.enum(['TLS', 'SSH']).default('TLS'),
});

// Crypto Discovery makes a real, active network connection to the target.
// Covers both TLS (certificate) and SSH (host key) probing.
cryptoRouter.post('/discover', requirePermission('scan:create'), async (req, res) => {
  const parsed = discoverSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request', requestId: req.id });

  const outcome = await runCryptoDiscovery({
    orgId: req.auth.orgId,
    actorUserId: req.auth.userId,
    target: parsed.data.target,
    port: parsed.data.port,
    protocol: parsed.data.protocol,
  });

  if (!outcome.discovered) {
    return res.status(502).json({ error: 'discovery_failed', reason: outcome.error, requestId: req.id });
  }
  res.status(201).json(outcome.findings ? { findings: outcome.findings } : { finding: outcome.finding });
});

const discoverJwtSchema = z.object({ token: z.string().min(1), label: z.string().optional() });

// No network connection and no scope check -- this inspects a JWT the
// caller already holds (decodes the header only, never verifies the
// signature).
cryptoRouter.post('/discover/jwt', requirePermission('scan:create'), async (req, res) => {
  const parsed = discoverJwtSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request', requestId: req.id });
  try {
    const finding = await discoverJwtAlgorithm({ orgId: req.auth.orgId, actorUserId: req.auth.userId, token: parsed.data.token, label: parsed.data.label });
    res.status(201).json({ finding });
  } catch (err) {
    res.status(400).json({ error: 'invalid_jwt', reason: err.message, requestId: req.id });
  }
});

const discoverCertSchema = z.object({ pem: z.string().min(1), label: z.string().optional() });

// No network connection and no scope check -- this classifies a
// certificate the caller already extracted from a signed artifact (a PE,
// JAR, APK, etc.), not a certificate BCI itself fetched.
cryptoRouter.post('/discover/code-signing', requirePermission('scan:create'), async (req, res) => {
  const parsed = discoverCertSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request', requestId: req.id });
  try {
    const finding = await discoverCodeSigningCertificate({ orgId: req.auth.orgId, actorUserId: req.auth.userId, pem: parsed.data.pem, label: parsed.data.label });
    res.status(201).json({ finding });
  } catch (err) {
    res.status(400).json({ error: 'invalid_certificate', reason: err.message, requestId: req.id });
  }
});

cryptoRouter.get('/inventory', requirePermission('finding:view'), async (req, res) => {
  res.json({ findings: await listCryptoFindings(req.auth.orgId) });
});

cryptoRouter.get('/cbom', requirePermission('finding:view'), async (req, res) => {
  res.json(await buildCbom(req.auth.orgId));
});

cryptoRouter.get('/readiness', requirePermission('finding:view'), async (req, res) => {
  res.json(await computeReadiness(req.auth.orgId));
});
