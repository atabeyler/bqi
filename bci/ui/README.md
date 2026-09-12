# BCI UI — M15 Standalone Frontend

A minimal but real, working React frontend for the BCI API — not a mockup.
Every page is wired to a live endpoint and every button does what it says
(create an asset, start a scan, generate a report, run an engine health
check). This is a working core, not the full 17-area surface described in
the long-term spec (Security Graph visualization, Vulnerabilities/SBOM,
Policies, Rule management, full Administration are not built yet) — it
proves the pattern end to end so those areas can be added the same way.

## Pages

- **Login** — org slug + email + password against `POST /auth/login`
- **Dashboard** — BCI Security Score + Coverage Score + open finding count
- **Assets** — list + create (asset:create-gated)
- **Scans** — list scan jobs + start a new scan (scan:create-gated); a scan
  that isn't covered by an approved authorized scope reports the policy
  engine's denial reason back to the user rather than pretending it started
- **Findings** — list + detail drawer with Explain (AI or deterministic
  fallback), Verify fix (targeted re-check), Confirm/False-positive
  (finding:verify-gated)
- **Reports** — generate any of the four report types (report:export-gated)
  and view one, including its integrity status (`integrityValid`)
- **Engines** — health table + a manual health-check trigger (system:manage-gated)
- **Quantum & PQC** — Quantum Compute Gateway provider health, the org's
  quantum execution policy (system:manage-gated to edit), a Remediation
  Optimizer trigger with its benchmark verdict (finding:update-gated),
  recent benchmarks and quantum job history; a Crypto Discovery trigger
  with a TLS/SSH protocol selector (scan:create-gated — both make a real,
  authorized-scope-checked network connection) plus a separate JWT
  algorithm decoder (no network call, no scope needed — it only decodes a
  token the user pastes in), and the resulting Crypto Inventory, PQC
  Readiness score, CBOM component count, and migration roadmap.
  Deliberately never shows a "Quantum Powered Security" style claim — only
  genuinely measured provider health, benchmark verdicts, and discovery
  results

RBAC is enforced server-side as always (M2) — the UI only hides actions a
user's token doesn't carry the permission for; every button still goes
through the real permission check on the API.

## Development

```bash
npm install --prefix bci/ui
cp bci/ui/.env.example bci/ui/.env   # point VITE_BCI_API_URL at your BCI API
npm run dev --prefix bci/ui          # http://localhost:5173
npm test --prefix bci/ui
```

Verified end-to-end during development with a real BCI API + a headless
browser: login, dashboard scores loading from real data, creating an asset
through the UI and seeing it land in the database, and logout all worked
against the actual running stack, not mocks. The Quantum & PQC page was
verified the same way against a live BCI API: an approved scope, a real
Crypto Discovery TLS handshake against `example.com` returning
RSA-2048/quantum-vulnerable, and provider health/policy/inventory/readiness
all rendering the real response data end to end.
