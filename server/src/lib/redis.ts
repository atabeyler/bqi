/**
 * Optional Redis connection — used when REDIS_URL is set, otherwise returns
 * null and callers fall back to an in-memory store (see onlineState.ts).
 */
import { Redis } from 'ioredis';
import { logger } from './logger.js';

let client: Redis | null = null;
let initialized = false;

export function getRedis(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  if (!initialized) {
    initialized = true;
    client = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      lazyConnect: false,
      // ioredis's own defaults (connectTimeout 10s, no commandTimeout) let
      // an unreachable/degraded Redis silently turn every caller here
      // (login throttling, online-user state, blocked-user cache, WebAuthn
      // challenges) into a multi-second stall instead of the fast fallback
      // to memory each caller already has a `catch` for -- observed
      // firsthand as login-request taking 7-12s under real load, enough to
      // trip a client-side request timeout and misroute an online login
      // into offline-login handling. Both timeouts are kept well under any
      // client-side request timeout so the memory fallback kicks in fast
      // whenever Redis is unavailable.
      connectTimeout: 2000,
      commandTimeout: 2000,
    });
    client.on('error', (err: Error) => {
      logger.warn({ err }, '[Redis] Connection error');
    });
  }
  return client;
}
