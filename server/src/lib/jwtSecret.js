/**
 * Centralized JWT signing secret. Previously each of auth middleware,
 * routes/auth.js, routes/emergency.js and services/socket.js hardcoded their
 * own `process.env.JWT_SECRET || 'change-me-in-production'` fallback -- if
 * the env var was ever missing in a real deployment, tokens would become
 * forgeable with that publicly-known string. In production we refuse to
 * start instead; in dev/test a random per-process secret is used so local
 * runs still work without an .env file, without ever falling back to a
 * known constant.
 */
const fromEnv = process.env.JWT_SECRET;

if (!fromEnv && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET ortam değişkeni tanımlanmamış — üretim ortamında zorunludur.');
}

export const JWT_SECRET = fromEnv || `dev-only-${Math.random().toString(36).slice(2)}-${Date.now()}`;
