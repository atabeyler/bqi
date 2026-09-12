/**
 * Short-lived, one-time-use storage for WebAuthn challenges (registration
 * and authentication ceremonies). A challenge is a fresh random value the
 * server hands to the browser and must independently re-check on the
 * matching /verify call -- storing it server-side (rather than trusting a
 * client-echoed value) is what makes the ceremony replay-resistant: a
 * captured response can't be re-submitted because consuming the challenge
 * here deletes it, and it also expires on its own after CHALLENGE_TTL_S.
 *
 * Backed by Redis when REDIS_URL is set (required for multi-instance
 * deployments -- an in-memory map wouldn't be visible to the instance that
 * handles the follow-up /verify request), falling back to an in-process Map
 * otherwise. Mirrors the Redis/in-memory fallback pattern already used by
 * lib/loginThrottle.ts and lib/onlineState.ts.
 */
import { getRedis } from './redis.js';
import { logger } from './logger.js';

const PREFIX = 'bqi:webauthn-challenge:';
const CHALLENGE_TTL_S = 5 * 60;

const memStore = new Map();

function memPrune() {
  const now = Date.now();
  for (const [key, entry] of memStore) {
    if (entry.expiresAt <= now) memStore.delete(key);
  }
}

export async function saveChallenge(key, challenge) {
  const r = getRedis();
  if (r) {
    try {
      await r.set(`${PREFIX}${key}`, challenge, 'EX', CHALLENGE_TTL_S);
      return;
    } catch (e) {
      logger.warn({ err: e }, '[WebAuthnChallengeStore] Redis write error, falling back to memory');
    }
  }
  memPrune();
  memStore.set(key, { challenge, expiresAt: Date.now() + CHALLENGE_TTL_S * 1000 });
}

// Reads and deletes in one step so a captured/replayed verify request can
// never find (and reuse) a challenge that already succeeded once.
export async function consumeChallenge(key) {
  const r = getRedis();
  if (r) {
    try {
      const redisKey = `${PREFIX}${key}`;
      const [[, challenge]] = await r.multi().get(redisKey).del(redisKey).exec();
      return challenge || null;
    } catch (e) {
      logger.warn({ err: e }, '[WebAuthnChallengeStore] Redis read error, falling back to memory');
    }
  }
  memPrune();
  const entry = memStore.get(key);
  memStore.delete(key);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry.challenge;
}
