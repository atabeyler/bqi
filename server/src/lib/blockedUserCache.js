/**
 * Short-TTL cache of each user's `blocked` status, consulted by
 * authMiddleware on every request so a token issued before an account was
 * blocked stops working shortly after the block -- without adding a
 * Postgres round-trip to every single authenticated request (see the
 * P1 finding on authMiddleware only checking `blocked` at login time).
 *
 * Backed by Redis when REDIS_URL is set (so a block made on one instance
 * is picked up by every instance within the TTL, not just the instance
 * that handled the PATCH), falling back to an in-process Map otherwise.
 * Mirrors the Redis/in-memory fallback pattern already used by
 * lib/loginThrottle.ts, lib/onlineState.ts and lib/webauthnChallengeStore.js.
 */
import { getRedis } from './redis.js';
import { logger } from './logger.js';
import { query } from '../services/database.js';

const PREFIX = 'bqi:blocked-user:';
// Bounds how stale the cache can be: worst case, a just-blocked user keeps
// API access for up to this long after the PATCH (unless invalidateBlocked
// below fires first, which it does on the same instance/Redis immediately).
const TTL_S = 45;

const memCache = new Map(); // userCode -> { blocked: boolean, expiresAt: number }

async function fetchBlockedFromDb(userCode) {
  try {
    const r = await query('SELECT blocked FROM auth_users WHERE user_code = $1', [userCode]);
    // No matching row (deleted account, or a user_code rename in flight) is
    // not the same as "blocked" -- routes that require the account to still
    // exist already check that separately.
    return r.rows[0]?.blocked === true;
  } catch (e) {
    // Fail open: a transient DB/Redis problem should degrade the same way
    // the rest of this app's caches do (see loginThrottle.ts, onlineState.ts)
    // rather than locking every authenticated user out.
    logger.warn({ err: e }, '[BlockedUserCache] DB read error, treating as not blocked');
    return false;
  }
}

export async function isUserBlocked(userCode) {
  const r = getRedis();
  if (r) {
    try {
      const cached = await r.get(`${PREFIX}${userCode}`);
      if (cached !== null) return cached === '1';
      const blocked = await fetchBlockedFromDb(userCode);
      await r.set(`${PREFIX}${userCode}`, blocked ? '1' : '0', 'EX', TTL_S);
      return blocked;
    } catch (e) {
      logger.warn({ err: e }, '[BlockedUserCache] Redis error, falling back to memory');
    }
  }
  const now = Date.now();
  const entry = memCache.get(userCode);
  if (entry && entry.expiresAt > now) return entry.blocked;
  const blocked = await fetchBlockedFromDb(userCode);
  memCache.set(userCode, { blocked, expiresAt: now + TTL_S * 1000 });
  return blocked;
}

// Called right after an admin blocks/unblocks a user (see routes/auth.js's
// PATCH /admin/users/:userCode) so the new state is picked up on this
// instance (and, via Redis, every instance) immediately instead of waiting
// out the TTL. Complements -- does not replace -- the Socket.IO
// force-disconnect already done there, which only reaches a currently
// online session; this cache is what protects the API itself.
export async function invalidateBlockedCache(userCode, blocked) {
  const r = getRedis();
  if (r) {
    try {
      await r.set(`${PREFIX}${userCode}`, blocked ? '1' : '0', 'EX', TTL_S);
      return;
    } catch (e) {
      logger.warn({ err: e }, '[BlockedUserCache] Redis write error');
    }
  }
  memCache.set(userCode, { blocked, expiresAt: Date.now() + TTL_S * 1000 });
}
