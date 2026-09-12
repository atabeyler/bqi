# BCI AI-Native Security Audit

Audit date: 2026-09-09  
Branch baseline: `main@0dc02c1e4b3e3a88b7360ee10983a7d3a49e6b63`

## Architecture decision

The existing `EngineAdapter -> Planner -> Pipeline -> Normalizer -> Correlation -> Risk -> Security Graph -> Worker` path remains authoritative. AI, agent, MCP, ML-BOM, and workload-identity facts enter through the existing passive `bci-posture-intelligence` adapter. No second finding, risk, graph, decision, or authorization subsystem was introduced.

The versioned snapshot contract accepts schema `1.0` and `1.1`. Version `1.1` represents AI applications, agents, models/providers/endpoints, tools, RAG/vector stores, memory, MCP clients/servers/tools/resources, datasets/frameworks, SPIFFE trust domains/SVIDs, workload/service/agent identities, and their relationships. Inventory alone does not create a vulnerability. A finding is emitted only when supplied attributes satisfy an exact deterministic rule.

## Official reference baseline

| Reference | Version/status used | Purpose |
| --- | --- | --- |
| OWASP GenAI LLM Top 10 | 2026, released 2026-08-03 | Rule metadata for prompt injection, sensitive disclosure, output handling, vector/RAG, and supply-chain observations |
| OWASP Top 10 for Agentic Applications | 2026 | Agent agency, tool privilege, memory/context, inter-agent trust, and supply-chain themes |
| OWASP Agent Control Standard | 2026 release | Human approval, least privilege, context minimization, and output-validation themes; no invented numeric control IDs |
| MITRE ATLAS | content 2026.08 | Exact evidence-gated technique mappings; ATT&CK mappings remain unchanged |
| NIST AI Agent Standards Initiative / NIST SP 800-5 | 2026 | Agent identity, authority, monitoring, and secure agent-system context; guidance, not certification |
| Model Context Protocol specification | 2025-06-18 authorization baseline plus current security guidance | Token audience, no token passthrough, consent/privacy, and tool safety facts |
| CycloneDX | 1.7 and 2026 Authoritative Guide to ML-BOM | Model, dataset, provider, model-card, component, and provenance inventory |
| SPDX | 2.3 existing exporter; SPDX 3.0.1 AI profile reviewed | Existing package export retained; SPDX 3 AI serialization is not claimed as full support |
| SPIFFE/SPIRE | current stable specifications | Workload/service/agent identity and trust-domain posture |

Sources:

- https://genai.owasp.org/resource/owasp-genai-llm-top-10-2026/
- https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/
- https://genai.owasp.org/initiatives/agentic-security-initiative/
- https://github.com/mitre-atlas/atlas-data/tree/main/dist/v6
- https://www.nist.gov/artificial-intelligence/ai-agent-standards-initiative
- https://www.nist.gov/publications/summary-analysis-responses-request-information-regarding-security-considerations-ai
- https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
- https://cyclonedx.org/guides/OWASP_CycloneDX-Authoritative-Guide-to-AI-ML-BOM-en.pdf
- https://spdx.dev/use/specifications/
- https://spiffe.io/docs/latest/spiffe-specs/

## Capability truth matrix

| Capability | Status | Real execution/data path and boundary |
| --- | --- | --- |
| AI application/agent/model/provider/endpoint/tool discovery from approved evidence exports | FULL | Schema 1.1 -> posture adapter -> raw observation -> normalizer -> finding/evidence/entity persistence -> correlation/risk/graph |
| Prompt injection and indirect-prompt reachability | FULL | Requires observed untrusted reachability plus absent prompt boundary; no exploit is sent |
| Excessive agency and human-approval boundaries | FULL | Deterministic observed autonomous-action and approval facts |
| Unsafe tool invocation / tool privilege | FULL | Deterministic target-system facts; not BCI permissions |
| Sensitive-context leakage exposure / unsafe output handling | FULL | Requires observed reachability/sink and missing enforcement; evidence is redacted |
| RAG/vector posture, persistent memory, multi-agent trust | FULL | Evidence-only rules and relationships; no poisoning payloads are inserted |
| MCP inventory and posture | FULL | Snapshot-backed server/client/tool/resource inventory plus permission, poisoning-indicator, command, token, context, shadow-server, trust, and provenance rules |
| MITRE ATLAS mapping | FULL | Exact rule ID -> curated ATLAS 2026.08 technique; persisted decision evidence is mandatory |
| Existing MITRE ATT&CK mapping | FULL / unchanged | Existing mappings retained; framework discriminator separates ATLAS nodes |
| CycloneDX AI/ML-BOM | FULL | 1.7 model, dataset, model-card, provider service, framework, package, artifact, container, app, agent inventory and dependency graph |
| SPDX package SBOM | FULL / unchanged | Existing SPDX 2.3 package path retained |
| SPDX 3.0.1 AI profile | PARTIAL | Reviewed and represented internally; no full SPDX 3 AI-profile serializer/validator is claimed |
| AI provenance chain | FULL when supplied | Dataset -> Model -> Framework/Dependency -> Artifact -> Container -> AI Application -> Agent; missing edges are not inferred |
| SPIFFE/SPIRE identity posture | FULL when supplied | SPIFFE ID, trust domain, SVID and workload/service/agent facts use the existing graph and rules |
| Risk Model V3 | FULL | Versioned, deterministic, explainable, V2-compatible at zero new inputs; AI prediction alone is excluded |
| Graph / attack path / twin / what-if / optimizer | FULL | AI entity edges plus Finding/Evidence/ATLAS/Control/Remediation; approval, MCP disablement and identity-rotation simulations mutate snapshots only |
| Compliance/control mapping | FULL for failures | Evidence-backed failures only; absent evidence is never marked compliant |
| Direct cloud/SaaS discovery using credentials | BLOCKED | No approved credential/session profile; locked authorization/scope mechanisms may not be extended |
| Active authenticated remote MCP enumeration | BLOCKED | No approved target credential/session path; no unauthorized session use |
| Live SPIRE Workload API collector | BLOCKED | Requires an approved workload socket/trust context and deployment dependency |
| Continuous shadow-MCP network discovery | BLOCKED | Requires a scoped collector/scheduler unavailable without changing locked mechanisms |
| Destructive prompt/tool exploitation | BLOCKED | Prohibited by PASSIVE/SAFE_ACTIVE/RESTRICTED boundaries |

## Locked security boundary

Scope, AuthN, AuthZ, Authentication, Authorization, RBAC, Roles, Permissions, Policies, Tenant Isolation, deny-by-default behavior, authorization middleware, gateway/session authorization, and trust-boundary enforcement were read-only. New read endpoints reuse `requireAuth` and `report:view`; simulations reuse `finding:update`. No permission or role was created.

Target-system agent IAM, MCP permissions, and SPIFFE identities are cyber posture entities, never BCI authorization records.

