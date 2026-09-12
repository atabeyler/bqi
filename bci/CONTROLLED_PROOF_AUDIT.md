# Controlled Proof of Impact — Architecture and Security Audit

## Purpose

Controlled Proof validates evidence-backed web-content impact without creating a second scanner or producing simulated proof. Technical Security Impact Validation and optional Customer-Visible Public Demonstration are separate capabilities.

The module is restricted to an authenticated `system_admin` holding the existing `system:manage` permission. It introduces no role, permission, scope-approval flow, authorization bypass, or tenant-isolation exception.

## Reused BCI capabilities

| Area | Reused capability | Decision |
| --- | --- | --- |
| Discovery | `fuzzDiscovery` | Discover real same-origin endpoints and GET parameters; do not guess endpoints. |
| HTTP execution | `nativeHttp` and bounded curl execution | Reuse health checks, rate limits, timeouts, and fail-closed behavior. |
| Security engines | Nuclei, Smart Fuzz, Smart Intrusive, and Naabu adapters | Execute through the existing worker and job queue; do not duplicate scanners. |
| Normalization | Existing engine normalizers | Convert real output into bounded observations and proof candidates. |
| Findings | Existing tenant-scoped findings | Link matching findings; do not create duplicates or inflate risk. |
| Evidence | Existing decision and report evidence | Store redacted hashes, provenance, timestamps, and validation outcomes. |
| Audit | Existing audit service | Record lifecycle events without credentials, cookies, tokens, or response bodies. |
| Authorization | Existing AuthN, RBAC, and `system:manage` enforcement | Preserve unchanged. |

## Current architecture

```text
authenticated system_admin + system:manage
        |
        v
direct target URL
        |
        v
existing worker job queue
        |
        v
Nuclei + Smart Fuzz + Smart Intrusive + Naabu adapters
        |
        v
existing normalizers + historical evidence correlation
        |
        v
fuzzDiscovery candidates
        |
        v
fixed server-generated marker
        |
        v
bounded baseline and validation requests
        |
        +--> NO_PATH
        +--> POTENTIAL
        +--> VERIFIED_IMPACT_PATH
        |
        v
Proof ID + timestamps + token hash + evidence hash + provenance + audit
```

Scanner binaries remain in the worker data plane. The API persists an `ANALYZING` run and dispatches it through the existing PostgreSQL-backed queue. The UI polls the tenant-scoped record until a terminal result is stored. Cancelling a run also cancels its linked worker job.

## Security Impact Validation

- Each analysis receives a cryptographically random 128-bit Proof ID.
- The only validation value is the system-generated `BCI VALIDATION · <Proof-ID> · <timestamp>` marker.
- Users cannot supply HTML, JavaScript, arbitrary text, commands, files, redirects, credentials, or sessions.
- Validation is limited to real discovered same-origin GET candidates and bounded sequential requests.
- `VERIFIED_IMPACT_PATH` requires the exact marker to be absent from the baseline and present in a successful supported response.
- A generated safe-query candidate cannot produce `POTENTIAL` or `VERIFIED` by itself.
- `NO_PATH` and `POTENTIAL` never create verified decision evidence.
- Response/reflection evidence proves request-response impact only; it does not prove public homepage visibility.

## Customer-Visible Public Demonstration

Public demonstration never replaces vulnerability evidence. It is eligible only after a real security-impact path is verified and an implemented provider adapter is configured for the exact canonical hostname.

The implemented path is `cloudflare-edge-worker`. It uses a fixed marker, two unauthenticated public observations, an absolute 5–30 second expiry, resource cleanup, and a final observation verifying marker absence. Existing conflicting routes are rejected rather than replaced. The worker becomes a transparent pass-through after expiry even if cleanup is delayed.

Provider discovery never implies provider control. Credentials remain environment-only, target mappings are exact-host allowlists, and unavailable credentials or mappings fail closed.

## Platform support matrix

| Platform family | Status | Technical boundary |
| --- | --- | --- |
| Cloudflare | IMPLEMENTED | Temporary edge-worker demonstration with fixed marker, observation, absolute expiry, cleanup, and absence verification. |
| AWS CloudFront, Fastly, Akamai | BLOCKED | Safe transformation requires provider-specific deployment or configuration not implemented by the current adapter set. |
| Azure Front Door | BLOCKED | Available rules do not provide the required safe HTML-body transformation path. |
| Firebase Hosting, Vercel, Netlify, AWS Amplify, Azure Static Web Apps, Wix | BLOCKED | A marker requires a deployment or equivalent site change. |
| IIS, Nginx, Apache | BLOCKED | A remote origin change cannot guarantee automatic expiry without configuration modification or a preinstalled mechanism. |
| Kubernetes Ingress | BLOCKED | A response-transform component must already exist or be deployed. |
| WordPress, Drupal | BLOCKED | Generic management paths modify persistent CMS content. |
| Unknown or custom infrastructure | UNSUPPORTED | No evidence-backed management path or implemented adapter can be selected. |

Blocked and unsupported entries are discovery results, not simulated adapters. Detecting a platform never grants control or changes its implementation status.

## Evidence and provenance

Evidence retains bounded, redacted metadata: Proof and run identifiers, normalized target, engine and validator identifiers, rule/category/severity, eligibility or rejection reason, timestamps, response status and size metadata, hashes, provider status, execution result, and failure reason.

Raw bodies, cookies, credentials, session identifiers, authorization headers, API tokens, and arbitrary query values are not persisted in proof evidence.

## Safety invariants

- No persistent origin file, CMS, template, database, account, configuration, web-shell, backdoor, or scheduled persistence change.
- No arbitrary payload, command execution, credential acquisition, brute force, destructive action, availability disruption, or uncontrolled request burst.
- No synthetic, guessed, model-generated, or hard-coded `VERIFIED` result.
- No browser, screenshot, or rendered-content capability is claimed without a real implementation and correlated evidence.
- Public `VERIFIED` requires real unauthenticated observations and verified expiry.
- Failure to validate impact, visibility, cleanup, or expiry fails closed.
- AuthN, AuthZ, RBAC, roles, permissions, policies, tenant isolation, and execution classifications remain unchanged.

## Operational limitations

- Nuclei and Naabu require their pinned binaries in the worker image.
- Worker execution and lifecycle persistence require the configured PostgreSQL service.
- Provider-backed public demonstration requires a least-privilege credential and exact-host mapping.
- Missing dependencies must produce unavailable or environment-blocked states and must never fabricate results.

## Audit conclusion

Controlled Proof extends existing BCI execution, evidence, provenance, and audit paths. It does not create a duplicate scanner, general-purpose exploitation system, or authorization bypass.
