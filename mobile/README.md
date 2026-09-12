# BQI Android (Capacitor)

A Capacitor shell around the existing `client/` React app, reusing the exact
same offline-first sync architecture, device auth, and local AI built for
the Windows desktop app — ported to Capacitor's async, Promise-based native
APIs. The web app and the desktop app are both completely unaffected; this
directory only ever consumes the already-built `client/dist`.

**Distribution: sideloaded APK only, never Google Play.** This mirrors the
desktop app's closed institutional distribution model (self-signed
Authenticode cert, no Microsoft Store). There is no Play Store listing, no
Play App Signing enrollment, and the release workflow never touches the Play
Console — it only publishes the signed APK to this repo's GitHub Releases.

## Architecture

```
Capacitor WebView (no separate "main process" — unlike Electron, native
plugins are called directly from the same JS context as the web app)
┌─────────────────────────────────────────────────────────────────┐
│ client/ React app (unchanged) + client/src/services/mobileBridge.js │
│  window.bqiMobile.{isMobileApp, cloudUrl, platform}          │
│                                                                     │
│ client/src/mobile/db/       — @capacitor-community/sqlite (async), │
│  migrations identical to desktop/db/migrations (duplicated, not    │
│  shared — Vite can't resolve cross-package files)                  │
│                                                                     │
│ client/src/mobile/sync/     — queue, engine, conflict: same         │
│  idempotent-push / cursor-pull / optimistic-concurrency protocol   │
│  as desktop/sync/, ported to async/await                           │
│                                                                     │
│ client/src/mobile/auth/     — device id (BQI-AND-XXXXXXXX), bcrypt   │
│  offline-login, @aparajita/capacitor-secure-storage (Android        │
│  Keystore-backed, not localStorage)                                │
│                                                                     │
│ client/src/mobile/localAI/  — same offline extractive search/       │
│  summarize/compare engine as desktop, ported to async               │
└──────────────────────────────┬──────────────────────────────────┘
                                │ HTTPS, same /api/sync, /api/devices,
                                │ /api/analysis endpoints the desktop
                                │ app and the web app use
                                ▼
                    Backend (server/, unchanged — see desktop/README.md
                    for the sync protocol, which is shared verbatim)
```

`client/src/services/nativeBridge.js` picks `desktopBridge.js` or
`mobileBridge.js` based on which platform is actually running, so UI
components (`LoginPage.jsx`, `HistoryView.jsx`, the sync-status badge, the
conflict-resolution modal) never branch on platform themselves — they just
call `isNativeApp` / `nativeAuth` / `nativeSync` / `nativeAI` /
`nativeConnectivity`.

**ÇIKIŞ YAP vs BU CİHAZI UNUT.** `client/src/mobile/auth/session.js`
exposes two distinct sign-out operations, not one. **ÇIKIŞ YAP**
(`logoutSession()`) marks the encrypted cached session `signedOut: true`;
the cached JWT, bcrypt password verifier and this device's offline-login
authorization are deliberately preserved, so the login screen is shown again
without destroying the ability to authenticate locally. A later successful
offline password login clears `signedOut` and re-opens the local session.
**BU CİHAZI UNUT** (`forgetDevice()`, Settings → Security) immediately
removes the usable local session/offline credential and clears
`device_meta.last_authorized_user_id` / `last_authorized_at` plus the
offline-lockout counters, so a fresh online login is required before offline
login works again on this device. When network use is allowed it also
best-effort calls `DELETE /api/devices/:deviceId`. If Manual Offline Mode is
active, no old bearer JWT is written to renderer `localStorage` or another
plaintext file: only an account-correlated `{ deviceId, userCode }` tombstone is kept inside
the Android Keystore-backed secure store — never a bearer token or password
verifier. The next successful online login to that same account uses its fresh
JWT to settle the server-side revoke before the device is registered again; a
different account's JWT is never used for the older account's revoke. Upgrading from v3.2.0 also removes the short-lived legacy
`bqi_pending_device_revoke` localStorage entry if it exists.

**ÇEVRİMDIŞI MOD.** A separate, user-selected app-wide preference (Settings
→ Bağlantı, `client/src/services/appModePreference.js`), completely
independent of the login/device-authorization state above -- neither
`client/src/mobile/auth/session.js` nor this preference module ever imports
the other. Switching it on suspends cloud connectivity, live sync, and every
online-only service (Socket.IO, the update check, the weather widget, cloud
AI routing, passkey management) while preserving local data and the pending
sync queue, regardless of the device's actual reachability. Switching back
to Otomatik reconnects the socket if needed and (once
`nativeAuth.needsReauth()` says a fresh login isn't required) flushes the
pending sync queue via the existing `nativeSync.forceSync()` call -- no new
sync/socket mechanism, just gating the existing ones at their call sites.
Manual Offline Mode never changes or deletes the offline-login authorization
by itself.

## Why this needed a cross-origin fix

Capacitor's WebView loads the app from `capacitor://localhost` (or
`https://localhost` on some configs), which is **not** the deployed backend
origin — the same problem the Electron desktop app has with its local
static server (see `desktop/README.md`'s "local HTTP server" section).
`client/src/services/api.js`'s `baseFor()` resolves the real API origin
dynamically from `window.bqiMobile.cloudUrl` (or
`window.bqiDesktop.cloudUrl` on desktop) instead of assuming
same-origin, and `server/src/index.js`'s CORS allowlist explicitly includes
Capacitor's native origins alongside the desktop's fixed static-server
origin. Override the default cloud URL at build time with
`VITE_MOBILE_CLOUD_URL` if pointing at a self-hosted/staging backend.

## Setup

```bash
cd client && npm ci && npm run build   # produces client/dist, which mobile/ wraps
cd ../mobile && npm ci
npm run sync                           # cap sync android — copies client/dist in
npm run open                           # opens the project in Android Studio
```

Requires the Android SDK (`ANDROID_HOME`/`ANDROID_SDK_ROOT`) with
`platform-tools`, `platforms;android-36`, and `build-tools;36.0.0` installed,
and a JDK (17+; CI uses Temurin 21).

```bash
cd android && ./gradlew assembleDebug     # unsigned debug APK, for testing
                ./gradlew assembleRelease  # release APK — signed if
                                           # keystore.properties exists (see below)
```

## Signing

Same free, self-signed approach as the desktop app's Authenticode
certificate: a self-signed Android keystore, generated once, used to sign
every release so Android will accept it as an update to an existing install
(Android requires all versions of an app to share one signing key — unlike
Windows, self-signed vs. CA-issued makes no UX difference for a sideloaded
APK, so there is no SmartScreen-equivalent warning to work around).

- `mobile/android/keystore.properties.example` is the committed template.
  Copy it to `mobile/android/keystore.properties` (gitignored, never
  committed — see `mobile/android/.gitignore`) and fill in the real
  passwords to sign locally.
- `app/build.gradle` reads `keystore.properties` if present and signs the
  `release` build type; if the file is absent, `assembleRelease` still
  succeeds and produces an **unsigned** APK.
- CI (`.github/workflows/android-release.yml`) reconstructs
  `keystore.properties` from four repository secrets at build time —
  `ANDROID_KEYSTORE_BASE64` (the `.jks`, base64-encoded),
  `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` —
  and never commits the keystore itself.

The actual keystore and its password were generated once and delivered
directly to the project owner (never committed to the repository) — see the
delivered README for the exact secret values and the fingerprint to verify
against.

## Releases

`.github/workflows/android-release.yml` fires automatically on every push to
`main` — unfiltered by path, since every commit bumps the app version via
`scripts/bump-version.js` and so is a distinct release — or via a manual
`workflow_dispatch`: it builds `client/dist`, syncs it into the Android
project, builds and signs the release APK, and uploads it to a GitHub
Release.

The APK is attached to the **same versioned release as the Windows
installer** — tag `v<version>`, read from the root `package.json` (kept in
sync across `package.json`/`client`/`server` by `scripts/bump-version.js`
on every commit) — rather than a separate tag, so both
installers for a given app version live in one place. Whichever release
workflow (this one, or `desktop-release.yml`) runs first for a given
version creates that release (published immediately, not a draft — a
GitHub draft release can't be found by tag lookup, which used to cause the
two workflows to race and duplicate); the other finds it by tag and adds
its asset alongside. The uploaded file is named `BQI-<version>.apk`.

Distribution from there is direct download + manual "Install from unknown
sources" on each device (or an MDM push) — there is no store listing. The
app does check for and prompt about newer APK releases: `UpdateBanner.jsx`
polls this server's own `/api/version/latest` (never GitHub directly), and
approving downloads the APK itself and hands it straight to the system
package installer via a `FileProvider` intent (`mobileUpdate.approve` in
`client/src/services/mobileBridge.js`, using `@capacitor/filesystem` +
`@capacitor-community/file-opener`) — not a Play-Store-style silent
auto-install, but it skips routing the download through Chrome, which
otherwise flags sideloaded `.apk` downloads with its own warning on top of
Android's own unknown-sources install prompt.

## Testing

`client/src/mobile/**/*.test.js` and the bridge/auth regression tests run via
the client's normal `npm test`. Native-plugin-dependent code
(`db/index.js`, `auth/secureStore.js`) is exercised through dependency
injection with a fake Capacitor SQLite connection backed by a **real**
in-memory `better-sqlite3` database. The GitHub Android emulator workflow
adds an actual Android runtime check on top of the JS suite; physical-device
verification is still required for OEM-specific Keystore behavior and
install/update UX.

Manual real-device acceptance should include: online password login → normal
Çıkış → airplane mode → same user/password offline login; Manual Offline Mode
with local analysis and zero app cloud traffic; Auto mode restoration and
queued sync; Bu Cihazı Unut followed by rejected offline login; and app
kill/relaunch around each of those transitions.
