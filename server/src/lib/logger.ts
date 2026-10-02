/**
 * Structured (JSON) logging — replaces console.log/warn/error.
 * auth.js / middleware/auth.js are intentionally untouched (out of scope).
 */
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'bqi-server' },
});

/**
 * Request/response header fields that carry credentials and must never reach log output (Render keeps logs readable to anyone
 * with dashboard access). The session JWT travels in the `bqi_jwt` cookie, so `cookie` must be redacted as well as `authorization`.
 */
export const HTTP_LOG_REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
];
