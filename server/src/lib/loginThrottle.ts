/**
 * Per-account login attempt lockout. Complements the IP-based
 * publicActionLimiter: that limiter stops a single IP from hammering
 * /login-request, but a distributed attack (many IPs, one fixed userCode)
 * would otherwise face no additional friction beyond bcrypt cost. Stored in
 * Redis when REDIS_URL is set (for multi-instance consistency), falling
 * back to an in-process Map when unset or on a Redis error.
 */
import { getRedis } from './redis.js';
import { logger } from './logger.js';

const PREFIX = 'bqi:login-fail:';
const MAX_ATTEMPTS = 5;
const LOCKOUT_SECONDS = 5 * 60;

interface MemEntry {
  count: number;
  lockedUntil: number;
}

const memAttempts = new Map<string, MemEntry>();

export async function isLoginLocked(userCode: string): Promise<boolean> {
  const r = getRedis();
  if (r) {
    try {
      const count = await r.get(`${PREFIX}${userCode}`);
      return Number(count) >= MAX_ATTEMPTS;
    } catch (e) {
      logger.warn({ err: e }, '[LoginThrottle] Redis read error, falling back to memory');
    }
  }
  const entry = memAttempts.get(userCode);
  if (!entry) return false;
  if (entry.lockedUntil <= Date.now()) {
    memAttempts.delete(userCode);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

export async function recordLoginFailure(userCode: string): Promise<void> {
  const r = getRedis();
  if (r) {
    try {
      const key = `${PREFIX}${userCode}`;
      const count = await r.incr(key);
      if (count === 1) await r.expire(key, LOCKOUT_SECONDS);
      return;
    } catch (e) {
      logger.warn({ err: e }, '[LoginThrottle] Redis write error, falling back to memory');
    }
  }
  const now = Date.now();
  const entry = memAttempts.get(userCode);
  if (entry && entry.lockedUntil > now) {
    entry.count += 1;
  } else {
    memAttempts.set(userCode, { count: 1, lockedUntil: now + LOCKOUT_SECONDS * 1000 });
  }
}

export async function clearLoginFailures(userCode: string): Promise<void> {
  const r = getRedis();
  if (r) {
    try {
      await r.del(`${PREFIX}${userCode}`);
      return;
    } catch (e) {
      logger.warn({ err: e }, '[LoginThrottle] Redis clear error');
    }
  }
  memAttempts.delete(userCode);
}
