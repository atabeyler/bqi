# SFRE — Architecture (v1.0.0)

## Decision: extend the BQI server, no second system

Forensic audit of the repo (details in the final report) found: BQI = Node 22 ESM Express API + Postgres (`services/database.js`) + Python/Qiskit worker spawn (`quantumProcess.js`) + React client; **BCI** = separate cyber product under `bci/` (own DB, migrations, RBAC) — unrelated to finance. Mature, reusable BQI parts: RBAC/classification (`lib/rbac.js`), auth middleware, `dataEgressPolicy`, Evidence Objects/decision trace (`evidence.js`, `analysisOrchestrator.js`), the `benchmarks/` metrics (confusion matrix, PR-AUC), quantum reproducibility hashing, `webResearch.js`, vitest + CI. There is **no** financial-risk, graph, contagion or point-in-time machinery.

SFRE therefore lives in `server/src/sfre/` (same package, same test runner, same CI job) and mounts at `/api/sfre` behind the existing `authMiddleware` + RBAC.

**Language decision.** Numerics are pure ESM JavaScript (no new dependencies, deterministic IEEE-754 double arithmetic, seeded xoshiro128** PRNG), not Python: (1) the cascade/tail/anomaly workloads are small dense loops that run in milliseconds–seconds at realistic scale (benchmarks in the report); (2) one runtime keeps hashing, evidence and AI-firewall in-process (no JSON bridge to desynchronise); (3) numpy/scipy/sklearn are not part of the repo's pinned toolchain. Independent numerical verification is done by a **stdlib-only Python reference implementation** (`server/sfre/crosscheck/reference.py`) executed from the test suite. Python/SciPy remains the intended home for very large optimisation (>10⁴ funds), tracked as a limitation.

## Layout

```
server/src/sfre/
  core/        canonical JSON + SHA-256, seeded PRNG, result envelope & failure semantics, math utils
  data/        observation, PIT store + look-ahead firewall, immutable snapshots
  engines/     one module per model (M01…M52); anomaly/ ensemble
  research/    provider abstraction, registry, corroboration, KAP/SPK/BIST/IR/news provider shells
  evidence/    hash-chained evidence ledger + explain()
  governance/  model registry (lifecycle), run registry (reproducibility)
  ai/          AI firewall (validated narrative, deterministic fallback)
  alerts/      retail risk table
  validation/  metrics, walk-forward, holdout lock, negative controls, ablation, sensitivity, champion/challenger, golden cases, synthetic world
  pipeline.js  orchestration: snapshot → engines → ledger → run record
server/src/routes/sfre.js   HTTP API
docs/sfre/                  specification set
```

## Result envelope & failure semantics (`core/result.js`)

Every engine returns `makeResult({engine, modelId, modelVersion, status, value, uncertainty, coverage, unobserved, calibration, parameters, inputHashes, notes})`.

| Status | Meaning |
|---|---|
| `MEASURED` | arithmetic measurement, no risk classification (e.g. HHI) |
| `SIGNAL` | model's alarm criterion met (still UNCALIBRATED unless governance says otherwise) |
| `NO_SIGNAL` | model ran with adequate data and did not alarm (**not** safety) |
| `LOW_RISK` | only if `coverage = 1`, calibration `CALIBRATED`, and the caller asserts it; otherwise construction **throws** |
| `INSUFFICIENT_DATA` | too few observations for the method |
| `INSUFFICIENT_OBSERVABILITY` | required inputs are UNOBSERVED |
| `MODEL_UNCERTAIN` | non-converged / degenerate / ill-posed |
| `MODEL_DISAGREEMENT` | ensemble members disagree (reported, not averaged away) |
| `UNCALIBRATED` | risk classification requested but thresholds are uncalibrated |
| `COMPUTATION_FAILED` | input invalid or numerical failure (message attached) |

Invariant (tested): missing data can never yield `LOW_RISK`. Engines never throw on data problems; they return `COMPUTATION_FAILED`/`INSUFFICIENT_*`.

## Evidence ledger (`evidence/ledger.js`)

Append-only, hash-chained (`entry.hash = sha256(prev_hash ‖ canonical(entry))`). Node kinds: `CLAIM`, `ENGINE_RUN`, `MODEL` (equation id + version), `PARAMETERS` (values + hash), `INPUT` (observation/snapshot hashes), `SOURCE`. Edges encode `CLAIM → ENGINE_RUN → MODEL → PARAMETERS → INPUT → SOURCE → TIMESTAMP → HASH`. `explain(claimId)` returns the full path from the graph; `verify()` recomputes the chain and reports the first broken link. *The answer to "why did BQI say this" is the ledger path — never LLM text.*

## Governance (`governance/`)

* **Model lifecycle:** `DEVELOPMENT → VALIDATION → SHADOW → APPROVED → RETIRED` (also `* → RETIRED`; backwards moves allowed only to `DEVELOPMENT`). Transition to `VALIDATION` requires a spec reference; to `SHADOW` a validation report hash; to `APPROVED` a `shadow_report_hash` plus an approval by a **human actor distinct from the proposer**; `actor.kind === 'system'` can never approve. A model not `APPROVED` has its outputs labelled `NON_PRODUCTION` by the pipeline. There is no code path that auto-promotes. CALIBRATED status is only assignable at `APPROVED`.
* **Run registry:** each run stores `run_id, git_commit, dataset_snapshot_id, model_versions, parameter_hash, random_seed, dependency_versions (node, lockfile hash), result_hash`. Result hash excludes wall-clock fields, so same snapshot + models + seed ⇒ same hash (tested).

## AI firewall (`ai/firewall.js`)

AI sees only typed, validated engine results (`unwrapForAI` strips raw data). Output is validated before use: (1) every number in the narrative must appear in the typed results (after formatting tolerance) — no invented numbers; (2) every result's status label must be stated verbatim — uncertainty cannot be upgraded to certainty; (3) forbidden-term screen: buy/sell/hold/"al"/"sat" advice and accusation terms (fraud, manipulator, "dolandırıcı", "manipülatör", …); (4) on any violation the narrative is **discarded** and replaced by a deterministic template. The LLM cannot change a result: results are frozen before the call and compared by hash after.

## Research (`research/`)

`ResearchProvider` abstraction + registry ordered by tier. Existing `webResearch.js` (DuckDuckGo HTML) is wrapped as a `NEWS_UNVERIFIED` provider — one of many, never the sole source. KAP/SPK/BIST/IR/audit/market-data providers are **shells that report `UNAVAILABLE` until configured with a licensed/verified endpoint** (no scraping of unverified markup). Egress: respects BQI classification gate (CONFIDENTIAL/RESTRICTED never leave).

## HTTP API (`routes/sfre.js`, `/api/sfre`)

`POST /runs` (analyst+; body = observations + engine config → snapshot, run, ledger) · `GET /runs/:id` · `GET /runs/:id/explain/:claimId` · `GET /models` · `POST /models/:id/transition` (admin only, human) · `GET /health`. Validated input, size-capped, no raw stack traces.

## Persistence

`Store` interface (`append`, `get`, `list`) with in-memory and JSONL-file implementations (tested) and a Postgres DDL in `server/src/sfre/storage/schema.sql` for production. **The Postgres adapter is not exercised by tests in this environment** (no server available); production readiness requires that (see report).


## vNext extension

Systemic engines M60–M69, Market Surveillance 2.0 (M70) and the Financial System Digital Twin (M71) are specified in [VNEXT_SYSTEMIC.md](VNEXT_SYSTEMIC.md). They live in `server/src/sfre/engines/systemic/` and `engines/surveillance/`, reuse the existing engines and the result/ledger/registry/PIT contracts unchanged, and are `UNCALIBRATED` / `NON_PRODUCTION` until promoted through governance.
