# BCI Cyber Decision Intelligence Audit

Audit baseline: `main` at `8c9c6599fa6da17490dd377abc574a7f1a356ea0`.

This audit covers the complete `bci/` tree before implementation. `FULL`,
`PARTIAL`, `PLANNED`, and `MISSING` below describe the baseline. The branch
result column describes what this branch adds without overstating live
collector coverage.

| Main system | Baseline | Evidence found | Branch result |
| --- | --- | --- | --- |
| EngineAdapter/registry/planner/pipeline/worker | FULL | Canonical capability registry and Adapter → Planner → Pipeline → Normalizer → Correlation → Risk → Graph → Worker flow | Extended, not replaced |
| Trivy / OSV / Semgrep / Nuclei / Naabu | FULL | Registered adapters, normalizers, health checks, tests | Unchanged |
| Smart Fuzz / Intrusive / Resilience | FULL | Native adapters, bounded modules, execution provenance | Unchanged |
| Cloud CSPM | MISSING | `CLOUD_ACCOUNT` type existed but README stated zero adapter coverage | PARTIAL: AWS/Azure/GCP-neutral snapshot contract and deterministic posture rules; live provider collectors blocked |
| Kubernetes security | PLANNED | `KUBERNETES_CLUSTER` target matcher existed without adapter | PARTIAL: RBAC/workload/service/network rules and graph ingestion; live cluster collector blocked |
| Target identity/IAM security | MISSING | Only BCI's own locked RBAC existed | PARTIAL: target identity entities, privileges, trust, MFA and graph paths; BCI RBAC untouched |
| EASM | PARTIAL | Domain/IP/CIDR/Naabu/Nuclei discovery existed | PARTIAL: de-duplicated external entities/relationships and drift; continuous scheduler/collectors blocked |
| Browser DAST | PARTIAL | Smart Fuzz HTML/robots/OpenAPI discovery existed | PARTIAL: browser-observed route/form/API evidence model; no bundled browser runtime |
| Advanced API security | PARTIAL | API target plus Nuclei/Smart validation existed | PARTIAL: REST/OpenAPI/GraphQL/gRPC evidence and auth/authz/BOLA observations; active auth/session profiles blocked |
| CI/CD security | MISSING | Repository scanners only | PARTIAL: pipeline/artifact/deployment entities and deterministic unsafe permission/execution/secret rules |
| Supply chain / SBOM | PARTIAL | Trivy, OSV and CBOM existed | Extended with CycloneDX/SPDX ingestion/export and package dependency graph |
| Container/workload posture | PARTIAL | Container SCA existed | Extended with privilege, identity, exposure and network relationship posture |
| Database posture | MISSING | No database posture service | PARTIAL: non-destructive exposure/encryption/auth evidence rules and graph relationships; live DB connectors blocked |
| Network posture | PARTIAL | Naabu discovery and graph relationships existed | Extended with firewall/routes/trust-boundary entities and attack-path relationships |
| Baseline/drift/regression | PARTIAL | Asset risk history existed | FULL for versioned posture snapshots: entity/control/path/vulnerability regressions |
| PKI/certificate intelligence | PARTIAL | Real TLS/SSH/JWT/code-signing crypto discovery existed | Extended with inventory relationship and expiry/mismatch/reuse posture evidence |
| DNS/email posture | MISSING | Domain target only | PARTIAL: DNSSEC/dangling/SPF/DKIM/DMARC/MX evidence model; live DNS collector blocked |
| Sensitive-data exposure | PARTIAL | Trivy secrets and AI DLP existed | Extended with redacted target posture evidence; raw secret/PII persistence prohibited |
| Threat-intelligence fusion | PARTIAL | CISA KEV, FIRST EPSS, NVD existed | Extended graph model for threat/IOC/IOA/campaign facts; live STIX/TAXII transport blocked |
| ATT&CK matching | MISSING | No mapping table/service | PARTIAL: conservative exact-rule, persisted-evidence-gated mappings |
| Business impact / blast radius | PARTIAL | Asset criticality and structural BFS existed | Extended risk inputs and Cyber Entity graph; business impact is used only when observed |
| Control effectiveness | PARTIAL | Defensive placement heuristic existed | FULL evidence model with entity links and 0..1 effectiveness |
| Compensating controls | MISSING | No risk reduction input | FULL deterministic, bounded reduction in Risk V2 |
| Remediation/patch intelligence | PARTIAL | Workflow, verify, CVSS/EPSS/KEV optimizer existed | Extended with dependencies and Risk V2 context |
| Attack-path prioritization V2 | PARTIAL | Asset-only BFS and patch order existed | Extended graph vocabulary; legacy optimizer preserved |
| Security Knowledge Graph V2 | PARTIAL | ASSET/VULNERABILITY projection existed | Extended with typed cyber entities, findings, evidence, controls, techniques and remediations |
| Cyber risk forecasting | MISSING | Real asset-risk history existed | FULL guarded linear trend with minimum data and confidence |
| Security digital twin | MISSING | No isolated scenario snapshot | FULL read-only relational snapshot with content hash |
| What-if simulation | MISSING | No scenario engine | FULL for required five scenario classes with before/after delta |
| Remediation optimization | FULL | Exact classical, quantum-inspired, simulator, hardware policy/fallback existed | Classical baseline reused; decision optimizer adds effort budget and dependencies |
| AI security analyst | PARTIAL | Hallucination-controlled finding explanation and DLP existed | Unchanged authority boundary; new decisions remain deterministic |
| Evidence/provenance intelligence | PARTIAL | Raw/normalized/finding sources, report/quantum provenance existed | Extended with redacted decision evidence and observed/corroborated status |
| Compliance mapping | PARTIAL | Audit evidence report existed | Extended with evidence-backed CIS/NIST/ISO failure mapping; no inferred compliance score |
| Cyber Decision Engine | MISSING | Separate optimizer/graph/risk services existed | FULL deterministic recommendation run with exact classical optimization and persisted provenance |

## Locked security boundary

The branch does not change these files or schemas:

- `src/middleware/auth.js`
- `src/routes/auth.js`
- `src/routes/scopes.js`
- `src/lib/rbac.js`
- `src/services/policyEngine.js`
- identity/scope/RBAC migrations `0002`, `0003`, and `0015`

New routes use existing `requireAuth` and existing permissions. Scan admission
still calls the existing scope policy unchanged. Target-system IAM and
Kubernetes RBAC facts are cyber entities; they are never BCI authorization
records.

## Blocked live integrations

Direct AWS/Azure/GCP credentialed collectors, live Kubernetes API collection,
authenticated browser sessions, authenticated API replay, database connectors,
continuous EASM scheduling, and TAXII transport are not implemented. This
repository has no approved credential/session profile and no permission model
for those secrets. Adding one would require a security-boundary decision in the
locked Scope/Auth/RBAC area. The branch therefore implements the safe boundary:
authorized targets accept redacted, versioned collector snapshots through the
existing scan authorization flow. These blocked integrations must not be
reported as live coverage.
