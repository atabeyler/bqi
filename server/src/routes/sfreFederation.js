import express from 'express';
import { logger } from '../lib/logger.js';
import { uploadLimiter } from '../middleware/rateLimit.js';
import { verifySignature, validateDocs, docId, NODE_ID_RE } from '../sfre/federation/package.js';

/**
 * /api/sfre-federation/import -- a local BFI node pushes RESULTS (never raw observations) to the cloud app.
 * Authenticated by an HMAC over the package (shared secret SFRE_FEDERATION_SECRET, >= 32 chars), not by a user session,
 * so the local machine needs no login. Without the secret the endpoint answers 503 and accepts nothing.
 * Stored append-only in sfre_records (collection "federated"); duplicates (same content) are ignored.
 */
export function createFederationRouter({ getStore, secret = () => process.env.SFRE_FEDERATION_SECRET, now = () => Date.now() } = {}) {
  const router = express.Router();
  router.post('/import', uploadLimiter, async (req, res) => {
    const key = secret();
    const node = String(req.get('x-bfi-node') || '');
    const check = verifySignature(req.body, key, req.get('x-bfi-timestamp'), req.get('x-bfi-signature'), now());
    if (!check.ok) {
      if (check.reason === 'NOT_CONFIGURED') return res.status(503).json({ error: 'federation is not configured on this server' });
      logger.warn({ reason: check.reason, node: node.slice(0, 64) }, '[SFRE federation] rejected package');
      return res.status(401).json({ error: 'invalid signature' });
    }
    if (!NODE_ID_RE.test(node)) return res.status(400).json({ error: 'x-bfi-node must match [A-Za-z0-9._-]{1,64}' });
    const bad = validateDocs(req.body); if (bad) return res.status(400).json({ error: bad });
    try {
      const store = await getStore(); let stored = 0; let duplicates = 0;
      for (const d of req.body.docs) {
        const id = docId(node, d);
        if (await store.get('federated', id)) { duplicates++; continue; }
        await store.append('federated', { id, node, kind: d.kind, title: d.title, summary: d.summary ?? '', created_at: d.created_at ?? new Date(now()).toISOString(), received_at: new Date(now()).toISOString(), payload: d.payload });
        stored++;
      }
      logger.info({ node, stored, duplicates }, '[SFRE federation] package imported');
      res.status(201).json({ ok: true, stored, duplicates });
    } catch (e) {
      logger.error({ err: e }, '[SFRE federation] storage failed');
      res.status(503).json({ error: 'storage write failed; nothing from this package may be assumed stored (re-sending is safe)' });
    }
  });
  return router;
}

let defaultRouter = null;
export default function federationRouter(req, res, next) {
  if (!defaultRouter) {
    defaultRouter = createFederationRouter({
      getStore: async () => {
        if (!process.env.DATABASE_URL) throw new Error('no database');
        const [{ query }, { PgStore }] = await Promise.all([import('../services/database.js'), import('../sfre/storage/pgStore.js')]);
        const store = new PgStore(query); await store.ensureSchema(); return store;
      },
    });
  }
  defaultRouter(req, res, next);
}
