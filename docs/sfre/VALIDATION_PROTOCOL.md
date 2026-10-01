# SFRE — Validation Protocol (v1.0.0)

Principle: **no SFRE model is called calibrated or predictive on the basis of this protocol being *implemented*.** It becomes evidence only when run on real point-in-time data that satisfies the gates below. Runs on synthetic data validate *machinery and internal consistency*, are labelled `SYNTHETIC`, and never upgrade a model's status.

## Metrics (never accuracy alone)

Precision, Recall, FPR, FNR, PR-AUC, Brier score, Expected Calibration Error (equal-mass bins), Lead Time (event_time − first alarm), Alarm Stability (fraction of consecutive-evaluation alarm flips; lower is better). Rates carry Beta–Binomial (Jeffreys) 95% intervals; zero-event cases report the rule-of-three bound. PR-AUC reuses `server/src/benchmarks/benchmarkMetrics.js` (existing, tested).

## Procedures (`validation/`)

1. **Walk-forward / rolling-window:** expanding or rolling train window; test strictly after; the firewall check runs before each fold. Parameters fitted only on train.
2. **Locked holdout:** the holdout period is declared once; `lockHoldout()` stores `sha256(holdout ids + period)`. Any evaluation that touches holdout records an access; **a second access invalidates the holdout** (`HOLDOUT_BURNED`) because it has been used for tuning.
3. **Negative controls:** (a) label permutation (seeded) — metrics must collapse to base-rate; (b) time-shuffled features; (c) matched healthy entities. A model whose permuted-label PR-AUC exceeds `base_rate + 3·SE` fails (`NEGATIVE_CONTROL_FAILED`) — indicates leakage.
4. **Ablation:** remove one engine/feature at a time; report Δ in each metric.
5. **Sensitivity / parameter perturbation:** ±20% (and ±50%) grid around each convention parameter; report metric ranges; unstable ⇒ flagged.
6. **Regime robustness:** metrics per regime (M12 filtered state); worst-regime reported.
7. **Champion/challenger:** challenger must beat champion on a pre-declared metric on the same folds *and* not degrade FPR beyond a declared tolerance; result is advisory — promotion is only via governance.

## Gates before any model may leave `VALIDATION`

* ≥ 30 independent positive events from real data (else status stays `UNCALIBRATED`, reason `INSUFFICIENT_EVENTS`);
* negative-control pass; locked-holdout evaluated exactly once;
* FPR interval upper bound ≤ declared budget on healthy entities (hundreds of healthy funds, not a handful);
* lead-time distribution reported with median and IQR.

## Golden cases

**TR-FUND-2026-001** is defined in `validation/goldenCases/TR-FUND-2026-001.json` as a *specification of the blind replay* — evaluation window, required observable precursors, healthy-control cohort rules, scoring rules — **without outcome-derived parameters**. Real data are `MISSING` in v1.0.0, so the replay returns **`BLOCKED_NO_DATA`** (which is *not* a pass). Rules:
* Replay uses `store.asOf(T)` for each T in the pre-event window; post-event information cannot be loaded (firewall + `assertNoFutureData`).
* `RELEASE_FAILURE` ⇔ sufficient observable precursor data (coverage ≥ declared minimum for the required fields) **and** no alarm before the event.
* Catching the event while alarming on healthy controls above the FPR budget is also a failure (`FALSE_ALARM_BUDGET_EXCEEDED`).
* Insufficient data ⇒ `BLOCKED_NO_DATA`/`INSUFFICIENT_OBSERVABILITY`, never `PASSED`.

**Market-integrity golden cases:** `validation/goldenCases/market-integrity.registry.json` — schema for SPK-verified past cases (case id, SPK publication reference, event window, entity) plus matched healthy negative controls drawn from the same period/sector. v1.0.0 registry is **empty** (no verified, point-in-time-reconstructible cases were available); the harness refuses to report results on an empty registry.

## Design-disclosure for the synthetic run

The synthetic experiment design was diagnosed once on seed 1 (a bug made the flow detectors unavailable — reference window 26 < detector minimum 30 — and the standard stress of 10% redemption saturated the impact model). Two design constants were changed after seeing seed-1 diagnostics (reference 26→40 weeks; standard stress 10%→3%). **Seed 1 is therefore burned; all reported numbers use fresh seeds 2–5.** No detector threshold or rule was tuned on seeds 2–5 results.

## Synthetic validation (machinery check)

`validation/syntheticWorld.js` generates seeded fund systems with injected crises and healthy periods. It is used for: known-answer tests, end-to-end walk-forward, negative-control behaviour, FPR measurement on hundreds of healthy synthetic funds, lead-time measurement, alarm stability. Results are reported in the technical report with the SYNTHETIC label.
