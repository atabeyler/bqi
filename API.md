# API Reference

Base URL: `https://site--anatoliaboldq--6ftfc8q7458m.code.run/api` (or `http://localhost:10000/api` locally).

All endpoints marked **auth** require `Authorization: Bearer <jwt>`. Admin-only endpoints additionally require the JWT's `isAdmin` claim.

---

## Auth (`/api/auth`)

| Method & Path | Auth | Description |
|---|---|---|
| `POST /login-request` | — | User code + password. Admin accounts get a JWT immediately; others trigger a mail-approval flow |
| `GET /approve/:token` | — | Renders a confirmation page for the mail approval link (does not approve by itself — see Security Notes in README) |
| `POST /approve/:token` | — | Approves a pending login |
| `GET /reject/:token` | — | Renders a confirmation page for the reject link |
| `POST /reject/:token` | — | Rejects a pending login |
| `GET /check/:token` | — | Polled by the client to check approval status; returns a JWT once approved |
| `GET /admin/users` | auth, admin | List all users |
| `POST /admin/users` | auth, admin | Create a user |
| `PATCH /admin/users/:userCode` | auth, admin | Update password/nickname/email/isAdmin/blocked |
| `DELETE /admin/users/:userCode` | auth, admin | Delete a user (cannot delete self or the last admin) |
| `GET /admin/audit-log` | auth, admin | Last 200 admin actions |

## Analysis (`/api/analysis`)

| Method & Path | Auth | Description |
|---|---|---|
| `GET /status` | — | Whether each AI provider key is configured |
| `GET /quantum-status` | — | Spawns the Qiskit worker with a trivial payload; reports simulator + IBM hardware health |
| `GET /fraud-trend` | auth, admin | Historical BDDK/BTK fraud-flag trend aggregated by date and category |
| `POST /upload` | auth | Extracts text from an uploaded document, or returns an image as base64 for vision analysis |
| `POST /generate` | auth | Main report generator — category + prompt in, DOCX/PDF report out. `quantumMode: true` additionally recomputes scenario/transaction/optimization tables on Qiskit. Successful generations are also recorded in the decision-intelligence trace store |
| `POST /scenario-deep-dive` | auth | Expands a single scenario from a prior report into a focused sub-analysis |
| `POST /chat` | auth | Streaming consultation chat, same triple-AI fallback as `/generate` |

## Platform & Decision Intelligence (`/api/platform`, versioned alias `/api/v1/platform`)

| Method & Path | Auth | Description |
|---|---|---|
| `GET /health/live` | — | Lightweight process liveness probe |
| `GET /health/ready` | — | Readiness summary for database, AI, quantum configuration, storage and Redis |
| `GET /models` | auth | Model registry and analysis prompt version |
| `GET /connectors` | auth, admin | Registered institutional connector definitions and health state |
| `GET /metrics` | auth, admin | In-process request latency/error metrics (p50/p95/max) |
| `GET /retention` | auth, admin | Current decision-record retention policy |
| `GET /overview` | auth, admin | Operational overview: service health, connectors, decision counts, pending approvals, recent risks and metrics |
| `GET /risk` | auth, admin | Recent risk-oriented analyses and BDDK/BTK flag rates |
| `GET /decisions/:analysisId` | auth | Provenance, evidence, data-quality and decision trace for an accessible analysis |
| `POST /decisions/:analysisId/outcome` | auth | Record the observed real-world outcome/assessment of a prior analysis |
| `POST /decisions/:analysisId/replay` | auth | Re-run the stored original request through the current analysis pipeline |

The machine-readable API definition for the new versioned platform surface is in [`openapi.yaml`](./openapi.yaml).

## Cyber Analysis (`/api/cyber-analysis`, versioned alias `/api/v1/cyber-analysis`)

Proxies to BCI (BOLD Cyber Intelligence, see [`bci/`](./bci/)), a separately
deployed product with its own database and users. BQI never reads
BCI's database directly; every request here is forwarded server-to-server
via a short-lived gateway session (see `server/src/services/bciClient.js`
and `bci/src/routes/gateway.js`). Restricted to admin/analyst roles.

| Method & Path | Auth | Description |
|---|---|---|
| `GET /status` | auth, admin/analyst | Whether the BCI integration is configured (`BCI_BASE_URL`/`BCI_GATEWAY_SECRET`) |
| `GET /overview` | auth, admin/analyst | BCI Security Score + Coverage Score |
| `GET /findings` | auth, admin/analyst | Open findings from BCI |
| `GET /findings/:id` | auth, admin/analyst | A single finding's detail |

A BCI outage or missing configuration returns `503 { error: "bci_unavailable" }`
rather than failing the rest of BQI.

## History (`/api/history`)

| Method & Path | Auth | Description |
|---|---|---|
| `GET /morning-brief/today` | auth | Today's auto-generated intelligence digest |
| `GET /morning-brief/list` | auth | Last 30 days of digest dates |
| `GET /morning-brief/date/:date` | auth | A specific day's digest (`YYYY-MM-DD`) |
| `POST /morning-brief/refresh` | auth, admin | Force-regenerate today's digest |
| `GET /list` | auth | Last 100 saved reports (own reports, or all reports for admins) |
| `GET /feed` | auth | Combined recent activity feed (reports + emergency logs) |
| `GET /:id` | auth | A single report |
| `GET /:id/download` | auth | Report as `.docx` |
| `GET /:id/download-pdf` | auth | Report as `.pdf` |

## Emergency (`/api/emergency`)

| Method & Path | Auth | Description |
|---|---|---|
| `GET /push/vapid-public-key` | — | Public VAPID key for registering a Web Push subscription |
| `POST /push/subscribe` | auth | Save a browser's Web Push subscription for emergency broadcasts |
| `POST /push/unsubscribe` | — | Remove a Web Push subscription by endpoint |
| `POST /center` | — | Notify the central mailbox of an emergency |
| `POST /users` | auth | Broadcast an emergency notification to other users |
| `POST /region` | — | Report a regional emergency |

## Voice (`/api/voice`)

| Method & Path | Auth | Description |
|---|---|---|
| `POST /transcribe` | auth | Audio → text via OpenAI Whisper |
| `POST /speak` | auth | Text → MP3 via OpenAI TTS |
| `POST /intent` | auth | Parses a natural-language voice command into `{actions, speak}` |

## Memory (`/api/memory`)

| Method & Path | Auth | Description |
|---|---|---|
| `GET /profile` | auth | The user's display profile (name, rank, unit, persona, language) |
| `PUT /profile` | auth | Update the profile |
| `POST /save-conversation` | auth | Save + AI-summarize a consultation chat transcript |
| `GET /conversations` | auth | List saved conversations |
| `GET /conversations/:id` | auth | A single saved conversation with full history |
| `PATCH /conversations/:id/archive` | auth | Archive/unarchive a conversation |
| `DELETE /conversations/:id` | auth | Delete a conversation |
| `GET /context` | auth | Aggregated memory context fed into the consultation system prompt |

## Files (`/api/files`)

| Method & Path | Auth | Description |
|---|---|---|
| `POST /upload` | auth | Upload a file (disk or S3/R2 depending on config) |
| `GET /:filename` | — | Download/serve a previously uploaded file |

## Weather (`/api/weather`)

| Method & Path | Auth | Description |
|---|---|---|
| `GET /current?lat=&lng=` | auth | Current temperature for a coordinate (proxies Open-Meteo) |

## Devices (`/api/devices`)

| Method & Path | Auth | Description |
|---|---|---|
| `POST /register` | auth | Authorize (or re-authorize) a device for the current account while online, enabling later offline login for that device |
| `GET /` | auth | List the account's registered devices |
| `DELETE /:deviceId` | auth | Revoke a device (e.g. lost/stolen laptop). `Bu Cihazı Unut` removes the local offline authorization immediately. When network use is allowed, the client also calls this endpoint best-effort using the current cached bearer token. If the device is forgotten while Manual Offline Mode is active, no bearer token is written to renderer localStorage or plaintext JSON; only an account-correlated `{ deviceId, userCode }` tombstone remains in the platform encrypted secure store; it contains no bearer token or password verifier. The server-side revoke is attempted only when the next successful online login belongs to that same account, using its fresh JWT before re-registration. A different account's JWT is never used to settle the older account's revoke. |

## Sync (`/api/sync`)

Offline-first sync for the desktop app; see [desktop/README.md](./desktop/README.md).

| Method & Path | Auth | Description |
|---|---|---|
| `POST /push` | auth | Apply a batch of queued offline operations (create/update/delete), idempotent by `operationId`, reporting per-operation conflicts |
| `GET /pull` | auth | Pull records changed since a cursor (`since`/`nextCursor`) |
| `GET /status` | auth | Device authorization state and the latest server-side sync cursor |

## Version (`/api/version`)

| Method & Path | Auth | Description |
|---|---|---|
| `GET /latest` | — | Latest published release version, notes and download URLs for the Android/Windows/macOS/Linux installers |
| `GET /download/:platform` | — | Streams the requested installer from GitHub Releases through this server (`platform` is `android`, `windows`, `mac`, or `linux`) |

## Health

| Method & Path | Auth | Description |
|---|---|---|
| `GET /api/health` | — | Root-level process liveness probe (distinct from `/api/platform/health/live`) |

---

**Note:** the app-wide "Offline Mode" toggle (Settings → Bağlantı, `client/src/services/appModePreference.js`) introduces no new or changed server endpoints. It is purely client-side request-gating — a localStorage-backed preference that stops calls to the endpoints already listed above (sync, version check, etc.) rather than anything the server needs to know about. On Android the gating is centralized in `client/src/services/mobileBridge.js` (`checkConnectivity()`/`performSync()` and everything that funnels through them no-op while the preference is on); on desktop it additionally reaches the Electron main process via an `appMode:get`/`appMode:set`/`appMode:changed` IPC channel (`desktop/appMode.js`, `desktop/main.js`), which stops and restarts main.js's own connectivity poller and sync/update timers — not just renderer-side UI gating.

For request/response shapes and quantum-mode field details (`quantum`, `fraud`, `optimizer` objects), see the route source directly in `server/src/routes/` — this file tracks endpoints and purpose, not full schemas.
