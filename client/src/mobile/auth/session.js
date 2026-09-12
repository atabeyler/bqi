import bcrypt from 'bcryptjs';
import { dbGet, dbRun } from '../db/index.js';

// A lost/stolen device with no OS-level lock of its own could otherwise be
// brute-forced against the cached bcrypt hash indefinitely -- offline login
// has no server to rate-limit it. After MAX_OFFLINE_ATTEMPTS wrong
// passwords in a row, the device locks itself out of offline login for
// OFFLINE_LOCKOUT_MS (see device_meta.offline_locked_until, migration
// 003_offline_lockout.sql). OFFLINE_SESSION_TTL_MS separately bounds how
// long a cached credential stays usable at all without a fresh online
// login, regardless of attempt count.
const MAX_OFFLINE_ATTEMPTS = 5;
const OFFLINE_LOCKOUT_MS = 15 * 60 * 1000;
const OFFLINE_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Browser-safe JWT payload decode (no Buffer global in a Vite web bundle),
// matching the same approach client/src/services/api.js's getCurrentUser()
// already uses for the web app. JWT payload segments are base64url (RFC
// 4648 §5: '-'/'_', no padding), not plain base64 -- atob() throws (or
// silently mangles the input) on those characters, which a token's payload
// commonly contains.
function decodeJwtPayload(jwt) {
  try {
    const [, payloadB64] = jwt.split('.');
    let base64 = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
    const pad = base64.length % 4;
    if (pad) base64 += '='.repeat(4 - pad);
    return JSON.parse(atob(base64));
  } catch {
    return null;
  }
}

// Orchestrates: online login → register this device with the account
// (server/src/routes/devices.js) → cache the session + device authorization
// locally, so a later launch with no network can still open the app for
// this same account (spec 5: "offline login only on a previously
// authorized device"). Mirrors desktop/auth/session.js exactly, ported to
// the async Capacitor SQLite + secure-storage APIs.
export function createSessionManager({ db, secureStore, deviceId, apiBaseUrl, fetchImpl = fetch, platform = 'android', appVersion }) {
  async function upsertDeviceMeta(fields) {
    const existing = await dbGet(db, 'SELECT device_id FROM device_meta WHERE device_id = ?', [deviceId]);
    if (existing) {
      await dbRun(db, `
        UPDATE device_meta SET platform = ?, last_authorized_user_id = ?, last_authorized_at = ? WHERE device_id = ?
      `, [fields.platform, fields.userId, fields.ts, deviceId]);
    } else {
      await dbRun(db, `
        INSERT INTO device_meta (device_id, platform, created_at, last_authorized_user_id, last_authorized_at)
        VALUES (?, ?, ?, ?, ?)
      `, [deviceId, fields.platform, fields.ts, fields.userId, fields.ts]);
    }
  }

  // "Bu Cihazı Unut" çevrimdışıyken server DELETE gönderemez. Eski 3.2.0
  // akışı bearer JWT'yi pendingServerRevoke ile mobileBridge'e döndürüyor
  // ve localStorage'a düz metin JSON olarak yazdırıyordu. Revoke borcunu
  // artık secureStore içinde yalnızca hassas olmayan deviceId işaretiyle
  // tutuyoruz; DELETE için gereken bearer token bir sonraki başarılı
  // *online* girişin taze JWT'sinden alınır.
  async function pendingRevoke() {
    const stored = await secureStore.load();
    return stored?.pendingServerRevoke?.deviceId ? stored.pendingServerRevoke : null;
  }

  async function clearPendingRevokeTombstoneIfCurrent(targetDeviceId, targetUserCode) {
    const current = await secureStore.load();
    // A fresh login may have replaced the tombstone while a best-effort
    // DELETE was in flight. Clear only the exact encrypted revoke debt that
    // was attempted; never clear a newly-created session or another account's debt.
    if (current?.pendingServerRevoke?.deviceId === targetDeviceId
      && current?.pendingServerRevoke?.userCode === targetUserCode
      && !current.userCode) {
      await secureStore.clear();
    }
  }

  async function tryPendingRevokeWithFreshJwt(jwt, freshUserCode) {
    const pending = await pendingRevoke();
    // A fresh JWT is account-scoped. Never use account B's token to settle
    // account A's device revoke. Legacy deviceId-only tombstones are also
    // deliberately not guessed; successful registration below safely
    // reassigns this physical device's unique server row to the new account.
    if (!pending?.deviceId || !pending?.userCode || !jwt || pending.userCode !== freshUserCode) return;
    try {
      const res = await fetchImpl(`${apiBaseUrl}/api/devices/${pending.deviceId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (res.ok || res.status === 404) {
        await clearPendingRevokeTombstoneIfCurrent(pending.deviceId, pending.userCode);
      }
    } catch {
      // Keep the encrypted tombstone. If device registration below also
      // fails, the next successful matching-account online login gets another chance.
    }
  }

  // Call once the renderer's existing login flow (the same LoginPage /
  // api.js the web app already uses) has produced a valid JWT. This is the
  // "must be online once" step -- it both saves the session locally and
  // authorizes this device_id against the account on the server.
  //
  // `password` is the plaintext the user just typed into the real login
  // form -- it is NEVER persisted as-is. It's hashed here (bcrypt, same
  // cost factor the server itself uses for auth_users, see
  // server/src/routes/auth.js) purely so a *later offline* login attempt on
  // this same device can be verified locally without ever storing or
  // needing the plaintext again.
  async function establishOnlineSession(jwt, password) {
    const payload = decodeJwtPayload(jwt);
    // Machine-readable codes (not Turkish prose) below, matching this
    // codebase's own 'local_llm_unavailable'-style convention -- errors
    // from this module previously leaked raw Turkish sentences straight
    // into a session an English/German/French/Arabic-language user set
    // up, bypassing the i18n system entirely (LoginPage.jsx's
    // attemptOfflineLogin() shows result.error/e.message verbatim). The UI
    // layer maps these codes through t() instead.
    if (!payload?.userCode) throw new Error('invalid_session_token');

    // If this device was forgotten while manually offline, use the fresh
    // JWT we have *now* to settle the old server-side revoke before the
    // registration below re-authorizes the same device. No old bearer token
    // ever needs to be persisted outside secureStore.
    await tryPendingRevokeWithFreshJwt(jwt, payload.userCode);

    // This one round-trip is the single gate on this device ever getting
    // offline-login capability at all -- a login just succeeded (the JWT
    // above proves it), so a brief network blip failing only *this* call
    // right afterwards would otherwise silently strand the device with no
    // offline fallback until the next fully-successful online login, with
    // nothing shown to the user (registerNativeSession's caller only
    // console.warns on failure -- see its comment in LoginPage.jsx). Retry
    // a few times before giving up, same reasoning as UpdateBanner.jsx's
    // periodic re-check: one failed attempt right after connectivity was
    // just proven to exist is far more likely transient than permanent.
    let res;
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        res = await fetchImpl(`${apiBaseUrl}/api/devices/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
          body: JSON.stringify({ deviceId, deviceName: `BQI Android (${platform})`, platform, appVersion }),
        });
        // Only a server-side/transient failure (5xx) is worth retrying; a
        // 4xx (e.g. invalid deviceId) will just fail identically again.
        if (res.ok || res.status < 500) break;
      } catch (err) {
        lastErr = err;
      }
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
    if (!res) throw lastErr || new Error('device_registration_failed:network');
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `device_registration_failed:${res.status}`);
    }

    // Async, not hashSync: bcryptjs's async hash() chunks the round loop
    // via nextTick (see its impl.js) instead of running cost-12 straight
    // through on the WebView's single JS thread -- hashSync here would
    // freeze the UI for however long that takes, every single login.
    const offlinePasswordHash = password ? await bcrypt.hash(password, 12) : undefined;
    await secureStore.save({
      jwt, userCode: payload.userCode, nickname: payload.nickname, isAdmin: !!payload.isAdmin,
      offlinePasswordHash,
    });
    await upsertDeviceMeta({ platform, userId: payload.userCode, ts: new Date().toISOString() });
    // A fresh online login re-proves the user knows the real password, so
    // any offline-lockout state from earlier failed attempts no longer
    // applies to the credential that was just cached.
    await dbRun(db, 'UPDATE device_meta SET failed_offline_attempts = 0, offline_locked_until = NULL WHERE device_id = ?', [deviceId]);
    return { userCode: payload.userCode };
  }

  // The actual offline login check: requires both (a) this device having
  // been online-authorized for this exact account before, and (b) the
  // entered password matching the bcrypt hash cached at that time --
  // verified locally, never against plaintext, never over the network.
  // Also enforces a lockout after repeated wrong attempts and a max age on
  // the cached credential itself (see the constants above) -- there's no
  // server to rate-limit an offline guess, so this device has to.
  async function verifyOfflineLogin(userCode, password) {
    if (!(await isOfflineLoginAllowed(userCode))) {
      return { ok: false, error: 'device_not_authorized_offline' };
    }
    const cached = await secureStore.load();
    if (!cached || cached.userCode !== userCode || !cached.offlinePasswordHash) {
      return { ok: false, error: 'no_offline_session' };
    }

    const meta = await dbGet(db, 'SELECT last_authorized_at, failed_offline_attempts, offline_locked_until FROM device_meta WHERE device_id = ?', [deviceId]);
    const now = Date.now();

    if (meta?.offline_locked_until && new Date(meta.offline_locked_until).getTime() > now) {
      return { ok: false, error: 'too_many_offline_attempts' };
    }
    if (meta?.last_authorized_at && now - new Date(meta.last_authorized_at).getTime() > OFFLINE_SESSION_TTL_MS) {
      return { ok: false, error: 'offline_session_expired' };
    }

    if (!(await bcrypt.compare(password || '', cached.offlinePasswordHash))) {
      const attempts = (meta?.failed_offline_attempts || 0) + 1;
      const lockedUntil = attempts >= MAX_OFFLINE_ATTEMPTS ? new Date(now + OFFLINE_LOCKOUT_MS).toISOString() : null;
      await dbRun(db, 'UPDATE device_meta SET failed_offline_attempts = ?, offline_locked_until = ? WHERE device_id = ?', [attempts, lockedUntil, deviceId]);
      return lockedUntil
        ? { ok: false, error: 'too_many_offline_attempts' }
        : { ok: false, error: 'invalid_credentials' };
    }

    await dbRun(db, 'UPDATE device_meta SET failed_offline_attempts = 0, offline_locked_until = NULL WHERE device_id = ?', [deviceId]);
    // A successful offline login is itself a fresh proof of identity --
    // clear signedOut so this cached jwt (see getSession()) is treated as
    // an active session again, including across the next relaunch.
    await secureStore.save({ ...cached, signedOut: false });
    return { ok: true, jwt: cached.jwt, userCode: cached.userCode, nickname: cached.nickname, isAdmin: cached.isAdmin };
  }

  // Returns the cached session even if the JWT itself has since expired --
  // an expired-but-previously-valid token still proves "this device was
  // authorized for this account" for the purpose of unlocking local SQLite
  // access while offline. The bcrypt hash is stripped before returning --
  // no caller of this function has a legitimate use for it.
  async function getSession() {
    const stored = await secureStore.load();
    // signedOut:true means the user actively logged out on this device --
    // the jwt/offlinePasswordHash below are deliberately still cached (see
    // logoutSession()) so a subsequent verifyOfflineLogin() keeps working,
    // but hydrateNativeSession()'s startup auto-login must not treat this
    // as "still signed in" just because a session happens to be cached.
    if (!stored || stored.signedOut === true) return null;
    const { offlinePasswordHash: _offlinePasswordHash, ...session } = stored;
    return session;
  }

  async function isOfflineLoginAllowed(userCode) {
    const row = await dbGet(db, 'SELECT last_authorized_user_id FROM device_meta WHERE device_id = ?', [deviceId]);
    return !!row && row.last_authorized_user_id === userCode;
  }

  // True once the cached JWT's own `exp` claim has passed -- mirrors
  // desktop/auth/session.js's needsReauth() exactly (same reasoning: no
  // server-side refresh-token endpoint, so a long offline stretch leaves a
  // stale cached token that would otherwise fail every sync call with 401
  // forever until the user happens to log out and back in).
  async function needsReauth() {
    const cached = await secureStore.load();
    if (!cached?.jwt) return false;
    const payload = decodeJwtPayload(cached.jwt);
    if (!payload?.exp) return false;
    return Date.now() >= payload.exp * 1000;
  }

  // Marks the session signed-out -- this device's offline-login
  // authorization (device_meta.last_authorized_user_id + the cached bcrypt
  // hash) is deliberately left intact, so the same account can immediately
  // offline-login again on this device without a fresh online round-trip.
  // Unlike before, the jwt itself is NOT nulled here: a null jwt made
  // verifyOfflineLogin() (which hands back cached.jwt as-is) return a
  // useless null token on every subsequent offline login, permanently
  // stranding a signed-out-then-offline user. signedOut is the actual
  // "am I logged in" flag now -- getSession() checks it, jwt is just
  // cached credential material that survives regardless. Mirrors
  // desktop/auth/session.js's logoutSession() exactly.
  async function logoutSession() {
    const cached = await secureStore.load();
    if (!cached) return;
    await secureStore.save({ ...cached, signedOut: true });
  }

  // Full device revocation: removes the usable local session/offline
  // credential and clears device_meta immediately. If a server-side DELETE
  // cannot be sent now, only a non-sensitive deviceId tombstone is kept in
  // encrypted secureStore; the next successful online login supplies a
  // fresh JWT to settle that revoke before re-registering the device.
  async function forgetDevice({ allowNetwork = true } = {}) {
    const cached = await secureStore.load();
    await dbRun(db, 'UPDATE device_meta SET last_authorized_user_id = NULL, last_authorized_at = NULL, failed_offline_attempts = 0, offline_locked_until = NULL WHERE device_id = ?', [deviceId]);

    if (!cached?.jwt) {
      if (!cached?.pendingServerRevoke?.deviceId) await secureStore.clear();
      return { pendingServerRevoke: null };
    }

    // Tombstone contains NO bearer token or password verifier. The userCode is only an encrypted account-correlation identifier used to prevent cross-account revocation.
    await secureStore.save({ signedOut: true, pendingServerRevoke: { deviceId, userCode: cached.userCode } });

    if (allowNetwork) {
      fetchImpl(`${apiBaseUrl}/api/devices/${deviceId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${cached.jwt}` },
      }).then(async (res) => {
        if (res.ok || res.status === 404) await clearPendingRevokeTombstoneIfCurrent(deviceId, cached.userCode);
      }).catch(() => {
        // Keep the encrypted marker; a later fresh online login retries it.
      });
    }

    // Never return a bearer token to mobileBridge/localStorage.
    return { pendingServerRevoke: null };
  }

  return { establishOnlineSession, verifyOfflineLogin, getSession, isOfflineLoginAllowed, logoutSession, forgetDevice, needsReauth };
}

export const _internal = { decodeJwtPayload };
