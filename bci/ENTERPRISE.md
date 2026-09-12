# BCI Enterprise / Sovereign Deployment Notes (M16)

Three deployment models (spec section 52):

- **BCI Cloud** — SaaS, multi-tenant (the default this codebase already
  targets: every table is `org_id`-scoped, RBAC and the policy engine
  enforce tenant isolation at the API layer).
- **BCI Enterprise** — customer's own data center/VPC, same codebase,
  customer-controlled Postgres and secrets.
- **BCI Sovereign** — air-gapped, no outbound internet access at all.

This document covers what's concretely implemented for Enterprise/Sovereign
and what's genuine operational guidance rather than built-and-tested code —
the two are kept clearly separate below.

## Implemented and tested

**Offline Intelligence Bundle** (`src/intelligence/bundleSigning.js`,
`src/services/bundle.js`, `scripts/bundle-{export,import}.js`) — the
mechanism a Sovereign instance uses to receive CVE/KEV/EPSS updates without
ever calling NVD/CISA/FIRST itself:

```bash
# On an internet-connected instance, once:
npm run bundle:generate-keys --prefix bci -- signing.pem verify.pub.pem
# Regularly, on that same instance:
npm run bundle:export --prefix bci -- signing.pem bundle-2026-09-04.json
# Ship bundle-2026-09-04.json + verify.pub.pem to the air-gapped instance, then there:
npm run bundle:import --prefix bci -- verify.pub.pem bundle-2026-09-04.json
```

Ed25519-signed (asymmetric — the air-gapped side only ever holds the public
key, never anything that could forge a bundle). An invalid signature or a
tampered payload imports nothing at all (fail closed), verified by real
sign/verify/tamper/wrong-key tests plus an end-to-end CLI run during
development (export from one database, import into a completely separate
one, confirm the data landed; a wrong-key import confirmed rejected with a
non-zero exit code).

**Backup/restore** (`scripts/backup.sh`, `scripts/restore.sh`) — plain
`pg_dump`/`pg_restore` custom-format wrappers reading `BCI_DATABASE_URL`.
Verified during development with a real round trip: backed up the dev
database, restored it into a fresh throwaway database, confirmed the data
and all 32 tables came back intact.

**Release integrity** (`scripts/generate-checksums.js`) — SHA-256
checksums for every file in a build output directory (e.g. `bci/ui/dist`),
verified against a real build during development. Wiring this into an
actual code-signing certificate and CI release pipeline is deployment-
specific and left to whoever operates that pipeline — this script is the
integrity primitive, not a full signed-release system.

## Deployment guidance (not new code — how the existing architecture already supports this)

**Horizontal scaling / HA**: the API (`src/index.js`) is stateless — all
state lives in Postgres, so running N API replicas behind a load balancer
needs no code change. Workers (`src/worker.js`, M4) are already a separate
process with configurable concurrency (`BCI_WORKER_CONCURRENCY`) and claim
jobs via `SELECT ... FOR UPDATE SKIP LOCKED`, so running multiple worker
replicas is already safe — two workers can never claim the same job. The
one real scaling dependency is Postgres itself: for HA there, use your
platform's standard managed-Postgres replication/failover (RDS Multi-AZ,
Cloud SQL HA, Patroni, etc.) — BCI's own schema and query patterns don't
require anything Postgres-specific beyond what M1-M15 already use
(`gen_random_uuid()`, arrays, JSONB).

**Sovereign/air-gapped posture checklist**: `BCI_AI_MODE=AI_DISABLED` (M13,
no outbound calls), the Offline Intelligence Bundle above instead of live
NVD/KEV/EPSS (M8), Nuclei's bundled local template
(`src/engines/templates/nuclei/`, M5 — no `-update-templates` call), and no
engine adapter (M5) makes an outbound call except the ones that are
themselves the point of an authorized active scan (Nuclei/naabu against an
in-scope target). `BCI_GATEWAY_SECRET` (M14) is only needed if BQI
integration is enabled; a pure-Sovereign standalone deployment can leave it
unset.

**Secret rotation**: `BCI_JWT_SECRET` and `BCI_GATEWAY_SECRET` are
independent (M2, M14) — rotating one never invalidates the other. Rotating
`BCI_JWT_SECRET` invalidates every issued session token immediately
(expected: users re-authenticate). There is no key-rotation automation
built here; this is a manual operational step today.
