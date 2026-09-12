# BQI Desktop (Electron)

A production Electron shell around the existing `client/` React app, adding
an offline-first SQLite cache and a real bidirectional sync engine against
the backend's Postgres database. The web app is completely unaffected —
this directory only ever *loads* the already-built `client/dist`, never
modifies it.

## Architecture

```
Electron main process                    Backend (server/, unchanged for web)
┌────────────────────────────┐            ┌───────────────────────────────┐
│ main.js — window, security, │  HTTPS     │ routes/sync.js                │
│ single-instance, menu       │───────────▶│  POST /api/sync/push          │
│                              │            │  GET  /api/sync/pull          │
│ preload.cjs — contextBridge  │            │  GET  /api/sync/status        │
│  → window.bqiDesktop   │            │ routes/devices.js             │
│                              │            │  POST /api/auth/devices/... (mounted at /api/devices) │
│ db/ — better-sqlite3, WAL,  │            │ analyses table + sync         │
│  migrations                 │            │  metadata columns, devices,   │
│                              │            │  sync_operations tables       │
│ sync/ — queue, engine,      │            └───────────────────────────────┘
│  conflict resolution        │
│                              │
│ auth/ — device id,          │
│  safeStorage session,       │
│  offline-login gate         │
│                              │
│ localAI/ — offline           │
│  find/summarize/compare      │
│                              │
│ connectivity.js — cloud/     │
│  sync/local tri-state        │
└──────────────┬───────────────┘
               │ serves client/dist over a local HTTP server (not file://)
               ▼
      client/ React app (unchanged), + client/src/services/desktopBridge.js
      (a no-op on the web build — window.bqiDesktop is undefined there)
```

## Why a local HTTP server instead of `file://`

`client/vite.config.js` has no `base` override, so the build emits
root-relative asset URLs (`/assets/...`). Those resolve correctly against an
`http://` origin (exactly like the deployed web app) but not against
`file://`, which has no root to be relative to. `desktop/staticServer.js`
serves the built SPA on `127.0.0.1` at a random port instead, so the web
build config never has to change to accommodate Electron.

## Scope: `analyses` is the synced entity

The offline/sync work is generic (entity-type-aware — see `sync/queue.js`
and `routes/sync.js`), but only the `analyses` table (reports) is wired
through it end-to-end in this pass. That matches what the desktop spec
actually needs: browsing/searching past reports offline, editing/deleting
them, and having those changes reconcile across devices. Live features
(chat, presence, video) stay Socket.IO-only — a single-user offline queue
isn't the right model for those.

## Sync protocol

Every local write (`db/analysesRepo.js`) is applied to SQLite immediately
and queues a durable row in `sync_queue` with a client-generated
`operation_id` (UUID). `sync/engine.js`:

1. **Push** — sends due queued operations to `POST /api/sync/push`, one op
   per entity per pass (so a create always lands before a later update to
   the same record). The server is idempotent per `operation_id` (a retried
   push replays the stored result instead of double-applying) and detects
   conflicts via optimistic concurrency: each op carries the `baseVersion`
   it was edited against, and the server rejects (rather than overwrites) a
   stale write.
2. **Pull** — fetches everything changed since a locally persisted cursor
   (`sync_state.pull_cursor`, tracks the server's monotonic
   `analyses.sync_revision`), applying tombstones for soft-deletes. A record
   with a local edit still in flight is never overwritten by a pull — it
   waits for that push to resolve (success or conflict) first.
3. **Conflicts** — when the server rejects a stale `baseVersion`, both sides
   are recorded in the local `conflicts` table (never silently discarded);
   `sync/conflict.js` exposes `resolveConflict(conflictId, 'kept_local' |
   'kept_server')` to settle it, re-queuing the local edit against the
   now-known server version or overwriting the local copy, respectively.
   `client/src/components/DesktopConflictModal.jsx` is the actual user-
   facing side of this: it polls `sync.listConflicts()` and shows both
   versions side by side with "Yerel sürümü kullan" / "Bulut sürümünü
   kullan" buttons.

Retries use exponential backoff (`sync/queue.js`, capped at 30 minutes,
giving up after 8 attempts but always keeping the row and its `last_error`
on disk — never silently dropped). Because state lives entirely in SQLite,
a sync interrupted by the app being closed simply resumes from the same
queue/cursor on next launch.

## Auth & device identity

Each install gets a unique id — `BQI-WIN-XXXXXXXX`, `BQI-MAC-XXXXXXXX`, or
`BQI-LINUX-XXXXXXXX` depending on the host OS (`auth/deviceId.js`),
persisted once. `auth/session.js` ties an online login to that device via
`POST /api/devices/register` (requires a fresh JWT) — this is the "online
authorization" step that later gates offline login: `isOfflineLoginAllowed`
only returns true for a `(deviceId, userCode)` pair that has actually
authorized online at least once.

**Offline login** is a real login, not a silently-resumed session: the same
LoginPage form is shown, and `verifyOfflineLogin(userCode, password)`
checks the entered password against a **bcrypt hash** (cost 10, matching
the server's own `auth_users` convention) cached locally at the last
successful online login — the plaintext password is never written to disk
or to `localStorage` at any point (see `client/src/pages/LoginPage.jsx`,
which also no longer persists a remembered password for the web app for
the same reason). `client/src/pages/LoginPage.jsx` takes the offline path
either when the connectivity monitor already reports `local`, or when the
online login request itself fails with a genuine network error (not a
credential rejection from a reachable server).

The whole cached session object (JWT + password hash) is encrypted at rest
via Electron's `safeStorage` (`auth/secureStore.js` — DPAPI on Windows,
Keychain on macOS, libsecret on Linux) — never `localStorage`, and never
reachable from the renderer at all (`contextIsolation: true`,
`nodeIntegration: false`). On a Linux install with no secret-service
running (some headless/minimal setups), `encryptionAvailable()` returns
false and the session falls back to memory-only for that process, forcing
online login again on the next launch rather than persisting anything
unencrypted to disk.

**ÇIKIŞ YAP vs BU CİHAZI UNUT.** `auth/session.js` exposes two distinct
sign-out operations, not one: **ÇIKIŞ YAP** (`logoutSession()`) marks the
cached session `signedOut: true` rather than nulling the JWT — the JWT,
password hash and this device's offline-login authorization are all
deliberately preserved, so `getSession()` correctly stops auto-restoring a
live session at next launch (showing the login screen again) while a
subsequent `verifyOfflineLogin()` still has real cached credentials to
verify against and can log the same account back in on this device
immediately, offline, without a fresh online round-trip — a successful
offline login clears `signedOut` again. **BU CİHAZI UNUT**
(`forgetDevice()`, Settings → Security) fully removes this device's
offline-login credential and authorization (`device_meta.
last_authorized_user_id`/`last_authorized_at` cleared, secure store wiped)
and, network permitting, revokes the device server-side (`DELETE
/api/devices/:deviceId`) — a fresh online login is required before offline
login works again on this device. When Offline Mode (below) is on,
`forgetDevice({ allowNetwork: false })` skips that DELETE call and instead
keeps an account-correlated pending-revoke tombstone only in the OS-keychain-
encrypted secure store. Returning to Otomatik alone never sends an old bearer
token; the next successful online login to the same account uses its fresh JWT
to settle the revoke before re-registering. A different account never has its
JWT used for the older account's revoke. An admin-forced block
(`auth:blocked`) also goes through `forgetDevice()`, not `logoutSession()`,
since a blocked user should not be able to relaunch and offline-login back
in.

**ÇEVRİMDIŞI MOD.** A separate, user-selected app-wide preference (Settings
→ Bağlantı, `client/src/services/appModePreference.js`), completely
independent of the login/device-authorization state above -- neither
`auth/session.js` nor this preference module ever imports the other.
Unlike the earlier, purely renderer-side gating, the toggle now reaches the
Electron **main process** itself, via a dedicated `appMode:get` /
`appMode:set` / `appMode:changed` IPC channel (`desktop/appMode.js`,
wired in `desktop/main.js` and exposed through `desktop/preload.cjs`):
`App.jsx` pushes every preference change to main through the
`desktopAppMode` bridge (`client/src/services/desktopBridge.js`), so main.js
-- not just the UI -- genuinely knows the mode. Switching it on calls
`appMode.set('offline')`, which persists the mode to a small JSON file in
the Electron `userData` dir (so a relaunch while Offline Mode is on does not
silently resume polling) and stops main.js's connectivity poller and its
sync/update timers outright, on top of suspending every online-only
renderer service (Socket.IO, the update check, the weather widget, cloud AI
routing, passkey management) -- local data and the pending sync queue are
untouched either way, regardless of whether this machine can actually reach
the server. Switching back to Otomatik calls `appMode.set('auto')`, which
runs `reconcileAuto()`: it restarts connectivity polling and checks once
immediately, bails out to a reauth prompt if `nativeAuth.needsReauth()`
says the cached session has expired, otherwise runs one sync pass via the
existing `sync.forceSync()` IPC call, restarts the periodic timers, pushes
the fresh connectivity state to the renderer, -- no new sync/socket mechanism was invented, the existing ones are just
centrally started and stopped from one place instead of being gated ad hoc at
their call sites. Pending device revocation is deliberately not an app-mode
responsibility: `auth/session.js` owns its encrypted tombstone and retries it
only after a successful matching-account online login supplies a fresh JWT.

## Local AI

Desktop Local AI supports real on-device generation through `node-llama-cpp`
with pinned GGUF tiers: Qwen2.5-1.5B-Instruct (MID) by default and
Qwen2.5-7B-Instruct (HIGH) on machines with sufficient RAM. Models are not
bundled; Settings → Local AI downloads and verifies the selected tier once,
after which new analyses can be generated with no network connection and are
saved to the local SQLite history as `Q LOCAL LLM (OFFLINE)`.
`localAI/offlineExtractive.js` remains the zero-download fallback for local
search/summarize/compare and archived-report matching when no generative model
is installed or generation fails. `localAI/provider.js` keeps failures behind
its provider boundary so an unavailable model degrades cleanly instead of
crashing the application.

## Packaging

All three desktop OSes are configured in the root `package.json`'s `build`
key (electron-builder):

| OS | Target | Shortcut/install UX |
|---|---|---|
| Windows | NSIS (`.exe`) | Start Menu + Desktop shortcut, uninstaller |
| macOS | dmg (x64 + arm64, universal build) | Drag-to-Applications disk image |
| Linux | AppImage (x64) | Single self-contained executable, no install step |

`desktop/build/icon.ico` (Windows) and `desktop/build/icon.png` (used at
runtime for the taskbar/window icon) are generated by
`desktop/build/generate-icon.py`, which renders `client/public/icon-source.svg`
with cairosvg -- the same source SVG and rendering pipeline as
`mobile/icon-source/generate.py`, so the desktop icon matches the Android
launcher icon instead of drifting out of sync. The same script also writes
`desktop/build/icon-mac.png`, a 1024x1024 render of the same design that
electron-builder uses to auto-derive the macOS `.icns` and the Linux
AppImage icon (both need a source image well above the 256px Windows icon).
Re-run it (`pip install cairosvg pillow && python3 desktop/build/generate-icon.py`)
whenever `icon-source.svg` changes.

```bash
npm run dist:win         # local Windows build, no publish
npm run dist:mac         # local macOS build, no publish (must run on macOS)
npm run dist:linux       # local Linux build, no publish
npm run release:win      # build + upload to the configured GitHub Releases target
npm run release:mac      # same, for macOS
npm run release:linux    # same, for Linux
```

electron-builder's mac/linux targets are built natively per-OS (there is no
cross-compiling a `.dmg` or `AppImage` from a different host) — the release
workflow below runs each platform's build on its own OS-matching runner.

## Code signing

electron-builder signs automatically whenever `CSC_LINK` (a path, URL, or
base64 data blob of a `.pfx`) and `CSC_KEY_PASSWORD` are set in the
environment, and silently builds unsigned when they're not — no code
change needed either way. This only applies to the **Windows** build.

**macOS and Linux builds are unsigned/ad-hoc** (`build.mac.identity: null`
in `package.json`) — there is no Apple Developer Program membership or
notarization credentials configured for this project. In practice:

- **macOS**: an unsigned, unnotarized `.app` downloaded from a browser is
  quarantined by Gatekeeper and refuses to open on a normal double-click —
  the user has to right-click the app → *Open* → confirm, once, the first
  time. This is a materially harder bar to clear than the Windows
  SmartScreen prompt below (there's no institutional GPO-style bypass
  short of an actual Apple Developer ID + notarization, ~$99/year).
- **Linux**: an AppImage has no OS-level code-signing convention to begin
  with; most desktop environments will at most warn that the file "is not
  marked executable" (which the app's own update-install flow already
  handles for update downloads — see "Releases & auto-update" below) or
  prompt via the file manager. No install-time trust prompt to work around.

If this ever needs to change, the Apple side requires a paid Apple
Developer Program membership, a Developer ID Application certificate, and
`notarytool` credentials wired into the release workflow (`CSC_LINK`-style
secrets plus `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` and
`build.mac.notarize` in `package.json`) — none of that exists today.

A self-signed Authenticode certificate (5-year validity, proper
`codeSigning` EKU) was generated for this project as a free option, since a
publicly CA-trusted certificate is a recurring paid cost. **A self-signed
certificate does not remove the Windows SmartScreen "Unknown Publisher"
warning for the general public** — it only works on machines where an
administrator has explicitly registered the certificate as trusted. For a
closed institutional deployment (this app's actual distribution model:
pre-provisioned accounts on organization-managed machines) that's a
one-time IT action rather than a blocker:

1. Import `bqi-codesign-public.cer` (the certificate's public half —
   safe to distribute, contains no private key) on each target machine, or
   push it fleet-wide via Group Policy, into **both**:
   - `Trusted Root Certification Authorities` (so Windows can validate the
     self-signed chain at all), and
   - `Trusted Publishers` (so it's actually accepted for code execution,
     not just chain-valid).
2. Set the two GitHub Actions secrets so `desktop-release.yml` signs
   automatically on every release: **Settings → Secrets and variables →
   Actions** → add `CSC_LINK` (the `.pfx`, base64-encoded) and
   `CSC_KEY_PASSWORD`.
3. For a local `npm run dist:win`, export the same two values as
   environment variables instead.

If broader (non-institutional) distribution is ever needed, a CA-trusted
certificate removes the SmartScreen warning for every machine without any
GPO step — either a traditional Authenticode cert (~$200-500/year,
DigiCert/Sectigo/SSL.com) or Microsoft Trusted Signing (~$10/month, instant
Microsoft-backed trust, requires a verified business identity via Azure).
Swapping to one later is the same two environment variables, no other
change.

Building the NSIS installer's icon/version-resource step requires `wine` on
Linux (a known electron-builder limitation, unrelated to code signing) — it
is not needed at all when building on an actual Windows machine or a
Windows CI runner, which is exactly what the release workflow below uses.

## Releases & auto-update

Update checking/installing goes through `electron-updater`'s `autoUpdater`
(configured in `main.js`'s `configureAutoUpdater()`, driven by the
`update:*` IPC handlers), but pointed at a **generic** feed served by this
app's own server instead of GitHub's own release-facing endpoints —
`GET /api/version/generic/latest.yml` (and `latest-mac.yml`/
`latest-linux.yml`), see `server/src/routes/version.js`. That route fetches
electron-builder's published feed file from the GitHub Release and rewrites
every URL inside it to point back at `/api/version/generic/download/:filename`
(also proxied there), so no installed client ever calls github.com
directly, same as the `/api/version/latest`+`/download/:platform` pair
Android still uses. Because the feed is a real electron-updater generic
provider, differential (blockmap) downloads work the same as they would
against GitHub directly: a client that already has a previous installer
cached only downloads the byte ranges that changed, via `Range` requests
this server forwards straight through to GitHub's asset API.

`.github/workflows/desktop-release.yml` fires automatically on every push to
`main` — unfiltered by path, since every commit bumps the app version via
`scripts/bump-version.js` and so is a distinct release — as well as on a
push of a `desktop-v*` tag, or a manual `workflow_dispatch`. It's a
3-way build matrix, one job per OS (`windows-latest`, `macos-latest`,
`ubuntu-latest`), each building only its own platform's installer (a
`.dmg`/AppImage can't be produced by cross-compiling from another OS) and
uploading it to the **same** GitHub Release alongside `latest.yml` via the
Actions-provided `GITHUB_TOKEN` — no manually-managed secret required
(except `CSC_LINK`/`CSC_KEY_PASSWORD` for the Windows job's code signing,
see above). Once a release exists, every previously-installed copy of the
app — on any of the three OSes — picks it up automatically the next time
it's online. On the client side, `main.js`'s `update:install` handler calls
`autoUpdater.quitAndInstall()`, which handles the quit-then-relaunch dance
per platform itself: the Windows NSIS installer runs and replaces the app
in place; on macOS the `.app` bundle is swapped; the Linux AppImage is
replaced and relaunched. Cutting a release
explicitly (e.g. to rebuild an older commit) still works the same way,
across all three platforms at once:

```bash
git tag desktop-v2.2.0
git push origin desktop-v2.2.0
```

`better-sqlite3` and `bcryptjs` are listed under `dependencies`, not
`devDependencies` — the packaged app needs both at runtime (native SQLite
addon and offline-password hashing respectively), and some CI pipelines run
`npm ci --omit=dev` before invoking electron-builder, which would silently
drop anything left in `devDependencies`.

See **[MANUAL_TEST_CHECKLIST.md](./MANUAL_TEST_CHECKLIST.md)** for the
scenarios that can only be verified on a real machine with a display and a
live deployment (offline login, cross-device conflict resolution, a
clean-machine installer run, ...) — none of those can be exercised inside
this project's headless Linux sandbox. Ideally run the checklist once per
OS (Windows, macOS, Linux) before a release that touches desktop code,
since the update-install step in particular (NSIS run vs. dmg mount vs.
AppImage relaunch) is genuinely different per platform.

## Native module ABI note

`better-sqlite3` is a native addon and must be built against whichever Node
ABI will load it — Electron's bundled Node for `npm run desktop` /
`desktop:dev`, or the system Node for `npm run test:desktop`. After `npm
install` it's built for the system Node, so tests work immediately. Running
`npx electron-rebuild -f -w better-sqlite3` switches it to Electron's ABI;
after that, plain-Node commands (`npm run test:desktop`) will fail to load
it until you run `npm rebuild better-sqlite3` to switch it back. None of the
`npm run dist:*`/`release:*` scripts have this problem — electron-builder
rebuilds the native addon for Electron automatically as part of packaging,
for whichever OS it's running on, regardless of prior state.
