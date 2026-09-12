/**
 * Online user and live location state.
 * Stored in Redis hashes when REDIS_URL is set (for multi-instance /
 * fast recovery after restart); falls back to an in-process Map when
 * unset or when a call fails — behavior is never interrupted.
 *
 * Note: video meeting state (activeMeetingByRoom) is intentionally NOT
 * included here — WebRTC connections are already tied to the process; on
 * a restart all socket connections drop and participants must rejoin
 * anyway, so moving this data to Redis wouldn't provide real persistence.
 */
import { getRedis } from './redis.js';
import { logger } from './logger.js';

const ONLINE_KEY = 'bqi:online-users';
const LOCATIONS_KEY = 'bqi:user-locations';
const DM_NOTIFY_PREFIX = 'bqi:dm-notified:';
// A new email notification is only sent for the first message of a
// conversation; this is how long a sender/recipient pair must go idle
// before their next message counts as starting a new one.
const DM_NOTIFY_IDLE_SECONDS = 30 * 60;

export interface UserLocation {
  lat: number;
  lng: number;
  city: string | null;
  updatedAt: number;
}

const memOnline = new Map<string, string>();
const memLocations = new Map<string, UserLocation>();
const memDmNotified = new Map<string, number>();

export async function setOnline(nickname: string, socketId: string): Promise<void> {
  const r = getRedis();
  if (r) {
    try {
      await r.hset(ONLINE_KEY, nickname, socketId);
      return;
    } catch (e) {
      logger.warn({ err: e }, '[OnlineState] Redis write error, falling back to memory');
    }
  }
  memOnline.set(nickname, socketId);
}

export async function removeOnline(nickname: string): Promise<void> {
  const r = getRedis();
  if (r) {
    try {
      await r.hdel(ONLINE_KEY, nickname);
    } catch (e) {
      logger.warn({ err: e }, '[OnlineState] Redis delete error');
    }
  }
  memOnline.delete(nickname);
}

export async function getOnlineNicknames(): Promise<string[]> {
  const r = getRedis();
  if (r) {
    try {
      return Object.keys(await r.hgetall(ONLINE_KEY));
    } catch (e) {
      logger.warn({ err: e }, '[OnlineState] Redis read error, using memory');
    }
  }
  return Array.from(memOnline.keys());
}

export async function getOnlineSocketId(nickname: string): Promise<string | undefined> {
  const r = getRedis();
  if (r) {
    try {
      const v = await r.hget(ONLINE_KEY, nickname);
      return v ?? undefined;
    } catch (e) {
      logger.warn({ err: e }, '[OnlineState] Redis read error');
    }
  }
  return memOnline.get(nickname);
}

export async function setLocation(nickname: string, loc: UserLocation): Promise<void> {
  const r = getRedis();
  if (r) {
    try {
      await r.hset(LOCATIONS_KEY, nickname, JSON.stringify(loc));
      return;
    } catch (e) {
      logger.warn({ err: e }, '[OnlineState] Redis location write error');
    }
  }
  memLocations.set(nickname, loc);
}

export async function removeLocation(nickname: string): Promise<void> {
  const r = getRedis();
  if (r) {
    try {
      await r.hdel(LOCATIONS_KEY, nickname);
    } catch (e) {
      logger.warn({ err: e }, '[OnlineState] Redis location delete error');
    }
  }
  memLocations.delete(nickname);
}

/**
 * True only for the first message of a new from->to conversation (i.e. the
 * pair has been idle for DM_NOTIFY_IDLE_SECONDS); false for every
 * subsequent message until that idle window elapses again. Used to email
 * a recipient once per conversation start rather than on every message.
 */
export async function isNewDirectMessageConversation(from: string, to: string): Promise<boolean> {
  const key = `${DM_NOTIFY_PREFIX}${from}->${to}`;
  const r = getRedis();
  if (r) {
    try {
      const result = await r.set(key, '1', 'EX', DM_NOTIFY_IDLE_SECONDS, 'NX');
      return result === 'OK';
    } catch (e) {
      logger.warn({ err: e }, '[OnlineState] Redis DM-notify check error, falling back to memory');
    }
  }
  const now = Date.now();
  const expiresAt = memDmNotified.get(key);
  if (expiresAt && expiresAt > now) return false;
  memDmNotified.set(key, now + DM_NOTIFY_IDLE_SECONDS * 1000);
  return true;
}

export async function getAllLocations(): Promise<Record<string, UserLocation>> {
  const r = getRedis();
  if (r) {
    try {
      const raw = await r.hgetall(LOCATIONS_KEY);
      const result: Record<string, UserLocation> = {};
      for (const [k, v] of Object.entries(raw)) result[k] = JSON.parse(v);
      return result;
    } catch (e) {
      logger.warn({ err: e }, '[OnlineState] Redis location read error');
    }
  }
  return Object.fromEntries(memLocations);
}
