import { verifyAccessToken } from '../lib/jwt.js';
import { query } from '../db/client.js';

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'unauthorized', requestId: req.id });
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return res.status(401).json({ error: 'unauthorized', requestId: req.id });
  }

  // Re-checked on every request, not just at token issuance, so blocking a
  // user takes effect immediately rather than only after their token expires.
  const { rows } = await query(
    'SELECT id, org_id, email, blocked FROM users WHERE id = $1 AND org_id = $2',
    [payload.userId, payload.orgId]
  );
  const user = rows[0];
  if (!user || user.blocked) {
    return res.status(401).json({ error: 'unauthorized', requestId: req.id });
  }

  req.auth = { userId: user.id, orgId: user.org_id, email: user.email };
  next();
}
