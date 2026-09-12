/**
 * Structured (JSON) logging — replaces console.log/warn/error.
 * auth.js / middleware/auth.js are intentionally untouched (out of scope).
 */
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'bqi-server' },
});
