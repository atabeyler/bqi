// Native bcrypt (not bcryptjs) specifically for its async hash()/compare() --
// Electron's main process is single-threaded like Node's, so a *synchronous*
// cost-12 hash here (bcryptjs's hashSync/compareSync, or even native
// bcrypt's own *Sync variants) blocks it entirely until done, stalling every
// other IPC call the renderer makes (including the dashboard's) for however
// long that takes. The async API offloads the hashing to libuv's thread
// pool instead, so the main process keeps servicing other IPC calls while
// it runs.
import bcrypt from 'bcrypt';

function decodeJwtPayload(jwt) {
  try {
    const [, payloadB64] = jwt.split('.');
    // JWT payload segments are base64url (RFC 4648 §5: '-'/'_', no
    // padding), not plain base64 -- Node's 'base64' decoder silently drops
    // those characters instead of mapping them, which shifts the byte
    // alignment and corrupts the decoded JSON rather than throwing.
    // 'base64url' decodes them correctly.
    return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// Orchestrates: online login → register this device with the account
// (server/src/routes/devices.js) → cache the session + device authorization
// locally, so a later launch with no network can still open the app for
// this same account (spec 5: "offline login only on a previously
// authorized device").
export function createSessionManager({ db, secureStore, deviceId, apiBaseUrl, fetchImpl = fetch, platform = 'win32', appVersion }) {
  function upsertDeviceMeta(fields) {
    const existing = db.prepare('SELECT device_id FROM device_meta WHERE device_id = ?').get(deviceId);
    if (existing) {
      db.prepare(`
        UPDATE device_meta SET platform = @platform, last_authorized_user_id = @userId, last_authorized_at = @ts
        WHERE device_id = @deviceId
      `).run({ deviceId, platform: fields.platform, userId: fields.userId, ts: fields.ts });
    } else {
      db.prepare(`
        INSERT INTO device_meta (device_id, platform, created_at, last_authorized_user_id, last_authorized_at)
        VALUES (@deviceId, @platform, @ts, @userId, @ts)
      `).run({ deviceId, platform: fields.platform, userId: fields.userId, ts: fields.ts });
    }
  }

  // "Bu Cihazı Unut" çevrimdışıyken server DELETE gönderemez. Eski 3.2.0
  // akışı bu işi daha sonra yapmak için bearer JWT'yi pendingServerRevoke
  // içinde renderer/appMode katmanına döndürüyor ve düz JSON dosyasına
  // yazdırıyordu. Revoke borcunu artık secureStore içinde yalnızca hassas
  // olmayan deviceId işaretiyle tutuyoruz; DELETE için gereken bearer token
  // bir sonraki başarılı *online* girişin taze JWT'sinden alınır.
  function pendingRevoke() {
    const stored = secureStore.load();
    return stored?.pendingServerRevoke?.deviceId ? stored.pendingServerRevoke : null;
  }

  function clearPendingRevokeTombstoneIfCurrent(targetDeviceId, targetUserCode) {
    const current = secureStore.load();
    // A fresh login may have replaced the tombstone while a best-effort
    // DELETE was in flight. Clear only the exact encrypted revoke debt that
    // was attempted; never clear a newly-created session or another account's debt.
    if (current?.pendingServerRevoke?.deviceId === targetDeviceId
      && current?.pendingServerRevoke?.userCode === targetUserCode
      && !current.userCode) {
      secureStore.clear();
    }
  }

  async function tryPendingRevokeWithFreshJwt(jwt, freshUserCode) {
    const pending = pendingRevoke();
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
        clearPendingRevokeTombstoneIfCurrent(pending.deviceId, pending.userCode);
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
  // needing the plaintext again. If establishOnlineSession is ever called
  // without a password (shouldn't happen from the real login flow), offline
  // login for this account on this device simply stays unavailable until it
  // is.
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
    // a few times before giving up -- mirrors client/src/mobile/auth/
    // session.js's identical fix.
    let res;
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        res = await fetchImpl(`${apiBaseUrl}/api/devices/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
          body: JSON.stringify({ deviceId, deviceName: `BQI Desktop (${platform})`, platform, appVersion }),
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

    const offlinePasswordHash = password ? await bcrypt.hash(password, 12) : undefined;
    const { persisted } = secureStore.save({
      jwt, userCode: payload.userCode, nickname: payload.nickname, isAdmin: !!payload.isAdmin,
      offlinePasswordHash,
    });
    upsertDeviceMeta({ platform, userId: payload.userCode, ts: new Date().toISOString() });
    // persisted:false means no OS keychain was available to encrypt the
    // session at rest -- secureStore already refused to write it as
    // plaintext, so the caller (main.js/LoginPage) knows this session
    // (and offline login) will not survive an app restart, and can tell
    // the user rather than have it silently fail on next launch.
    return { userCode: payload.userCode, sessionPersisted: persisted };
  }

  // The actual offline login check: requires both (a) this device having
  // been online-authorized for this exact account before, and (b) the
  // entered password matching the bcrypt hash cached at that time --
  // verified locally, never against plaintext, never over the network.
  async function verifyOfflineLogin(userCode, password) {
    if (!isOfflineLoginAllowed(userCode)) {
      return { ok: false, error: 'device_not_authorized_offline' };
    }
    const cached = secureStore.load();
    if (!cached || cached.userCode !== userCode || !cached.offlinePasswordHash) {
      return { ok: false, error: 'no_offline_session' };
    }
    if (!(await bcrypt.compare(password || '', cached.offlinePasswordHash))) {
      return { ok: false, error: 'invalid_credentials' };
    }
    // A successful offline login is itself a fresh proof of identity --
    // clear signedOut so this cached jwt (see getSession()) is treated as
    // an active session again, including across the next relaunch.
    secureStore.save({ ...cached, signedOut: false });
    return { ok: true, jwt: cached.jwt, userCode: cached.userCode, nickname: cached.nickname, isAdmin: cached.isAdmin };
  }

  // Returns the cached session even if the JWT itself has since expired --
  // an expired-but-previously-valid token still proves "this device was
  // authorized for this account" for the purpose of unlocking local SQLite
  // access while offline. Any actual server call still goes through
  // authMiddleware normally and is rejected/refreshed like any expired
  // token once connectivity returns (handled as an ordinary sync failure,
  // not a fatal desktop error).
  //
  // The bcrypt hash is stripped before returning -- the renderer (main.js's
  // IPC handlers are its only path to this function) has no legitimate use
  // for it, so there's no reason to hand it across the process boundary at
  // all, defense-in-depth on top of contextIsolation.
  function getSession() {
    const stored = secureStore.load();
    // signedOut:true means the user actively logged out on this device --
    // the jwt/offlinePasswordHash below are deliberately still cached (see
    // logoutSession()) so a subsequent verifyOfflineLogin() keeps working,
    // but hydrateNativeSession()'s startup auto-login must not treat this
    // as "still signed in" just because a session happens to be cached.
    if (!stored || stored.signedOut === true) return null;
    const { offlinePasswordHash: _offlinePasswordHash, ...session } = stored;
    return session;
  }

  function isOfflineLoginAllowed(userCode) {
    const row = db.prepare('SELECT last_authorized_user_id FROM device_meta WHERE device_id = ?').get(deviceId);
    return !!row && row.last_authorized_user_id === userCode;
  }

  // True once the cached JWT's own `exp` claim has passed. There is no
  // server-side refresh-token endpoint (JWTs here are short-lived bearer
  // tokens, not paired with a long-lived refresh token) -- reconnecting
  // after a long offline stretch with an expired cached token would
  // otherwise mean every sync call silently fails with 401 forever,
  // retried on a loop, until the user happens to log out and back in. This
  // lets performSync() (main.js) detect that proactively -- skip the
  // doomed network round-trip, and tell the renderer to prompt for a
  // fresh online login instead -- rather than discovering it only after
  // repeated failures. Re-authenticating reuses the existing online-login
  // flow as-is (establishOnlineSession below) and never touches the local
  // SQLite data or the sync queue -- whatever was queued while offline
  // stays queued and is picked up by the very next sync once the session
  // is valid again.
  function needsReauth() {
    const cached = secureStore.load();
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
  // cached credential material that survives regardless.
  function logoutSession() {
    const cached = secureStore.load();
    if (!cached) return;
    secureStore.save({ ...cached, signedOut: true });
  }

  // Full device revocation: removes the usable local session/offline
  // credential and clears device_meta immediately. If a server-side DELETE
  // cannot be sent now, only a non-sensitive deviceId tombstone is kept in
  // encrypted secureStore; the next successful online login supplies a
  // fresh JWT to settle that revoke before re-registering the device.
  function forgetDevice({ allowNetwork = true } = {}) {
    const cached = secureStore.load();
    db.prepare('UPDATE device_meta SET last_authorized_user_id = NULL, last_authorized_at = NULL WHERE device_id = ?').run(deviceId);

    if (!cached?.jwt) {
      // Preserve an already-pending tombstone if forgetDevice is called a
      // second time before a fresh login; otherwise there is nothing useful
      // left to retain.
      if (!cached?.pendingServerRevoke?.deviceId) secureStore.clear();
      return { pendingServerRevoke: null };
    }

    // This tombstone deliberately contains NO JWT, password hash, nickname or
    // role. userCode is retained only inside the OS-keychain-encrypted store
    // as an account-correlation identifier so another account's fresh JWT can
    // never be used to settle this revoke debt.
    secureStore.save({ signedOut: true, pendingServerRevoke: { deviceId, userCode: cached.userCode } });

    if (allowNetwork) {
      fetchImpl(`${apiBaseUrl}/api/devices/${deviceId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${cached.jwt}` },
      }).then((res) => {
        if (res.ok || res.status === 404) clearPendingRevokeTombstoneIfCurrent(deviceId, cached.userCode);
      }).catch(() => {
        // Keep the encrypted marker; a later fresh online login retries it.
      });
    }

    // Never return a bearer token to renderer/main app-mode persistence.
    return { pendingServerRevoke: null };
  }

  return { establishOnlineSession, verifyOfflineLogin, getSession, isOfflineLoginAllowed, logoutSession, forgetDevice, needsReauth };
}

export const _internal = { decodeJwtPayload };
