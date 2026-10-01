# SFRE — Mathematical Specification (v1.0.0)

Status vocabulary used throughout:

* **UNCALIBRATED** — the model or parameter has not been fitted to, or validated against, outcome data. Its output is a *measurement under stated assumptions*, never a probability of a real-world event.
* **ESTIMATED** — parameter fitted in-sample from supplied data, with a stated sample size and interval. Not yet validated out-of-sample.
* **CALIBRATED** — ESTIMATED **and** passed the Validation Protocol out-of-sample on real (not synthetic) data **and** approved through model governance. **No SFRE model holds this status in v1.0.0.** Code cannot assign it; only the governance transition `APPROVED` can.
* **UNOBSERVED** — the quantity is not present in point-in-time data. It is carried as `null` + an entry in `unobserved[]`. **UNKNOWN ≠ ZERO**: no engine may coerce it to 0, 1 or a mean. Where a bound can be computed without the value, the bound is reported; otherwise the result is `INSUFFICIENT_OBSERVABILITY`.

Conventions: prices `P` in a single declared currency (TRY); quantities in shares; `w` are fractions of NAV unless stated; `r_t = ln(P_t / P_{t-1})`; all windows are **strictly before** the evaluation time (see DATA_CONTRACT §Look-ahead firewall). "Convention" parameters (textbook defaults) are listed with their source and are UNCALIBRATED for the Turkish market.

Every model block lists: **Equation · Inputs/Units · Assumptions · Calibration · Uncertainty · Failure conditions · Validation**.

---

## M01 Market Microstructure (`engines/microstructure.js`)

**Equations.**
* Market-model abnormal return: `AR_t = r_t − (α̂ + β̂·r_{m,t})`, OLS over estimation window `[t−L−g, t−g)` (gap `g` ≥ 1 avoids contamination by the event window).
* Abnormal volume: `AV_t = (V_t − med(V_ref)) / (1.4826·MAD(V_ref))`.
* Amihud illiquidity: `ILLIQ = mean_t( |r_t| / DVol_t )`, `DVol = P·V` in TRY → units 1/TRY. Days with `DVol = 0` are excluded and counted (they are *not* zero illiquidity).
* Realized volatility: `σ_RV = sqrt(Σ r_t²)` over the window; EWMA variance `s²_t = λ s²_{t-1} + (1−λ) r²_t`, `λ = 0.94` (RiskMetrics convention, UNCALIBRATED).

**Inputs/Units.** price, volume (shares), market-index price. **Assumptions.** Daily bars; returns i.i.d.-ish within estimation window (not assumed Gaussian — robust z is used for flags). **Calibration.** α,β ESTIMATED (n and R² reported); λ convention. **Uncertainty.** OLS standard error of AR (`s_ε`), reported per point. **Failure.** `n < minObs` → `INSUFFICIENT_DATA`; zero variance of market → `COMPUTATION_FAILED`; missing volume → `INSUFFICIENT_OBSERVABILITY`. **Validation.** Known-answer on synthetic series with injected shocks; independent Python re-implementation (cross-check test).

## M02 Fund Concentration (`engines/concentration.js`)

**Equations.** `HHI = Σ w_i²`, `N_eff = 1/HHI`, top-k share `Σ_{i≤k} w_(i)`. Free-float exposure `FFE_k = q_k / FF_k` (fund shares held ÷ free-float shares); `FF_k = null` → UNOBSERVED (never ÷ total shares as a stand-in).
**Partial observation.** If observed weights sum to `s < 1`, remainder `ρ = 1 − s` is unobserved: `HHI ∈ [Σw², Σw² + ρ²]` (lower bound as the remainder spreads over infinitely many assets, upper bound as one asset). Reported as an interval, status `MEASURED` only if `ρ ≤ ρ_tol` (1e-9), else interval + `INSUFFICIENT_OBSERVABILITY` flag on the point value.
**Calibration.** None needed (arithmetic identity). **Failure.** negative weights, `Σw > 1+ε` → `COMPUTATION_FAILED`. **Validation.** known-answer; invariants `1/N ≤ HHI ≤ 1`.

## M03 Portfolio Overlap (`engines/overlap.js`)

**Equations.** Weighted overlap `O_ij = Σ_k min(w_ik, w_jk) ∈ [0,1]`; cosine `C_ij = w_i·w_j / (|w_i||w_j|)`. Liquidity-weighted overlap `LWO_ij = Σ_k min(w_ik, w_jk)·φ_k`, `φ_k = F̂(DTL_k)` — the empirical CDF of days-to-liquidate over the universe (parameter-free; rank-based, so no arbitrary scale).
**Invariants.** disjoint holdings ⇒ `O = 0`; identical ⇒ `O = Σw`; symmetry; `0 ≤ LWO ≤ O`. Assets with unobserved weights are excluded from both funds and the excluded mass is returned (`unobservedMass`); overlap is then a **lower bound** and labelled so.
**Calibration.** none. **Validation.** property tests (random portfolios), known-answer.

## M04 Liquidity (`engines/liquidity.js`)

`DTL_k = q_k / (π · ADV_k)` days, `ADV_k` = median daily volume over reference window (shares), `π` participation rate. `π` is a **convention parameter** (default 0.20, UNCALIBRATED, must be echoed in provenance). Fund liquidity profile `L(h) = Σ_{k: DTL_k ≤ h} w_k` (share of NAV liquidatable within `h` days). `ADV = 0/unobserved` ⇒ `DTL = UNOBSERVED` (not infinity-as-zero risk, not 0).
**Failure.** `π ∉ (0,1]` → `COMPUTATION_FAILED`.

## M05 Redemption/Flow (`engines/flow.js`)

Behavioral link: `Redemption_i^{r+1} = β_i · Loss_i^{r}` (TRY), where `β_i ≥ 0` is flow-per-unit-loss sensitivity. Estimation (when history supplied): OLS `flow_t/NAV_{t-1} = a + b·ret_{t-1} + ε`, `β = max(0, −b)`, with standard error and n. Without history `β` must be supplied by the caller and carries status UNCALIBRATED; if absent the secondary-redemption channel is `UNOBSERVED` and excluded **with a flag** (the result is a lower bound).
**Failure.** `n < 30` or zero variance of returns → `INSUFFICIENT_DATA`. **Uncertainty.** OLS standard error; bootstrap CI.

## M06 Leverage (`engines/leverage.js`)

Gross assets `GA`, debt `D`, equity `E = GA − D`, leverage `Λ = GA/E`. Margin requirement `E/GA ≥ m`. Deleveraging sale needed (selling `A` and repaying `A` of debt): `(E)/(GA − A) ≥ m ⇒ A* = max(0, GA − E/m)` (closed form).
**Unobserved leverage** (`D = null`): no margin sale is computed; instead the engine returns `INSUFFICIENT_OBSERVABILITY` and, if the caller supplies an explicit assumed maximum leverage `Λ_max`, a **sensitivity bound** labelled `ASSUMED`. Zero is never substituted.

## M07 Market Impact (`engines/impact.js`)

Two models, selectable and reported separately:
1. **Amihud-linear (ESTIMATED):** `d_k = min(1, ILLIQ_k · Q_k)`, `Q_k` = aggregate TRY sold in the round. Coefficient is the asset's own empirical ILLIQ — no free parameter.
2. **Square-root law (UNCALIBRATED unless `Y` is fitted):** `d_k = min(1, Y · σ_k · sqrt(Q_k / DVol_k))` (Almgren–Bouchaud form; `σ_k` daily volatility, `DVol_k` ADV in TRY). `Y` has no default — the caller supplies it with provenance; literature values (~0.5–1.5) are not imposed.
Impact is aggregate across sellers (price impact depends on total flow).
**Failure.** missing ILLIQ/σ/ADV → impact for that asset `UNOBSERVED`; the cascade then reports `INSUFFICIENT_OBSERVABILITY` for sales in that asset rather than assuming zero impact.

## M08 Financial Network (`engines/network.js`)

Bipartite fund–asset matrix `H` (TRY). Fund overlap network `A_ij = O_ij`. Weighted degree `s_i = Σ_j A_ij`; eigenvector centrality by power iteration from the uniform vector (deterministic; converges for non-negative irreducible `A`, otherwise reported `MODEL_UNCERTAIN`). Counterparty exposure matrix `X_ij` (i's claim on j) with `null` = UNOBSERVED; `Σ_j X_ij` is reported with an `unobservedCount`.

## M09/M10 Contagion & Fire-Sale Cascade (`engines/cascade.js`)

State: positions `q_ik` (shares), prices `p_k`, cash `c_i`, debt `D_i` (may be `null`), counterparty claims `X_ij`, redemption sensitivity `β_i`, margin ratio `m_i`.

Round `r = 0,1,…`:
1. **Shock (r=0 only):** price shocks `s_k ∈ [0,1]` (fractional decline) applied to `p`; exogenous redemption `R_i^0` (TRY). *Direct loss* `= Σ_k q_ik p_k s_k`.
2. **Redemption demand:** `Red_i^r = R_i^0·[r=0] + β_i · Loss_i^{r-1}` (secondary, tag REDEMPTION).
3. **Cash depletion:** `use_i = min(c_i, Red_i)`; shortfall `S_i = Red_i − use_i`; `c_i ← c_i − use_i`.
4. **Margin:** `A*_i = max(0, GA_i − E_i/m_i)` if `D_i, m_i` observed (tag MARGIN).
5. **Forced liquidation:** sell total `V_i = min(S_i + A*_i, GA_i)`. Policy *pro-rata* (vertical slice, default): `sell_ik = q_ik p_k · V_i/GA_i` (value). Alternative *waterfall* (most liquid first by DTL). Sales execute at pre-impact marks (documented simplification; seller's slippage is borne through the remaining position — alternative execution models are an ablation).
   Redemption sales (`S_i`) tagged LIQUIDITY at r=0 (cash depletion from exogenous redemptions) and REDEMPTION at r>0; margin sales tagged MARGIN. Proceeds of `S_i` leave the fund (paid to investors); proceeds of `A*_i` repay debt.
6. **Market impact:** `Q_k = Σ_i sell_ik`; `d_k = impact_k(Q_k)`; `p_k ← p_k(1 − d_k)`.
7. **Mark-to-market loss:** for every fund, remaining holdings lose `q_ik p_k d_k`. Attributed to sale *cells* `(seller, trigger)` pro-rata to sale value `sell_jk / Q_k` (linear attribution rule — a declared accounting convention, not a causal claim).
8. **Counterparty:** after marking, fund `j` with equity `≤ 0` fails: recovery `ρ_j = min(1, max(0, GA_j)/D_j)`; creditor `i` writes down `X_ij(1−ρ_j)` (tag COUNTERPARTY, once per failed counterparty).
9. **Convergence:** stop when `Σ_i V_i ≤ ε·ΣNAV⁰` (ε = 1e-9) or `r = r_max`. Hitting `r_max` ⇒ `MODEL_UNCERTAIN` (non-converged), never silently truncated.

**Two reconciling views of the same total loss** (`TotalLoss = Σ_i (NAV⁰_i − NAV_i^final − RedemptionsPaid_i)`):
* *By who:* `direct + self_impact + common_asset + counterparty` (self = seller is the loser; common-asset = other funds' sales).
* *By why:* `direct + liquidity + redemption + margin + counterparty`.
Both are asserted to equal TotalLoss to relative 1e-9 (tests). **Conservation identity:** `NAV^final_i = NAV^0_i − RedemptionsPaid_i − Loss_i`.
**Unobserved handling.** `D_i = null` ⇒ margin channel for fund i = UNOBSERVED (excluded and listed; result flagged *lower bound for that channel*); unobserved `X_ij` ⇒ excluded, listed; unobserved `β_i` ⇒ secondary-redemption channel excluded, listed.
**Calibration.** UNCALIBRATED (structure from Greenwood–Landier–Thesmar 2015 / Cont–Schaanning 2017 families; no parameter fitted to Turkish data). **Uncertainty.** sensitivity grid over impact scale, `β` (reported as ranges, not a CI). **Validation.** conservation tests, no-overlap ⇒ no cross-fund loss, monotonicity in shock, known-answer two-fund case, ablations.

## M11 Monte Carlo / Tail Risk (`engines/tailRisk.js`)

Scenario generation (seeded, xoshiro128**): (a) **historical block bootstrap** of joint return vectors (block length `b`, default `⌈n^{1/3}⌉`); (b) **parametric Gaussian** via Cholesky of the sample covariance — both always reported; their disagreement is a flagged output.
`VaR_α = −quantile_{1−α}(PnL)`; `ES_α = −mean(PnL | PnL ≤ −VaR_α)`; sample ES uses the exact tail count `⌈(1−α)N⌉`.
**Liquidity-adjusted loss:** `LAL_i = ES_i + Σ_k V_ik · ½ · d_k(V_ik)` (half the terminal impact of liquidating the position — exact for linear impact).
**Systemic contribution:** Euler/component ES `CES_i = E[ L_i | L_sys ≥ VaR_sys ]` averaged over the same tail scenarios; `Σ_i CES_i = ES_sys` exactly in-sample (tested).
**Uncertainty.** bootstrap CI over simulation batches; Monte-Carlo standard error. **Failure.** non-PSD covariance ⇒ ridge-free fallback to bootstrap only + flag; `N_obs < 60` ⇒ `INSUFFICIENT_DATA`.

## M12 Market Regime (`engines/regime.js`)

2-state Gaussian HMM (low/high vol) fitted by EM (Baum–Welch) on the **training window only**; operational output is the **filtered** probability `P(S_t | r_{1:t})` (forward algorithm). Smoothed probabilities use future data and are *forbidden* in point-in-time use (the API does not expose them). Convergence tolerance 1e-8 in log-likelihood, max 200 iterations; degenerate fits (state separation < 1 pooled σ or state occupancy < 5%) ⇒ `MODEL_UNCERTAIN`. Status UNCALIBRATED→ESTIMATED (in-sample).

## M13 Reverse Stress (`engines/reverseStress.js`)

**Problem.** `min_{s ∈ [0,cap]^K} ‖s‖²_{Σ⁻¹}  s.t.  Ψ(s) ≥ τ`, with `Ψ` = cascade systemic criterion (fraction of system NAV lost, or number of failed funds) and `Σ` the asset-return covariance (plausibility metric — Breuer–Csóka style). Optional redemption dimension scaled by caller-supplied `redemptionScale`.
**Solver (no global-optimality claim).** Seeded multi-start: random directions `u`; for each find the smallest scale `λ` with `Ψ(λu) ≥ τ` by bisection (monotonicity of `Ψ` in `λ` is *verified on a grid* and flagged if violated); then seeded local search over directions (accept-if-better coordinate perturbations with shrinking step). Output: best **feasible** shock found (re-verified by an independent re-run), its plausibility cost, and `globalOptimum: false`, `certificate: 'FEASIBLE_UPPER_BOUND_ON_MINIMUM_COST'`. If no direction reaches `τ` within `cap` ⇒ `NO_BREAKING_SHOCK_FOUND` (not "system is safe").

## M14 Financial Digital Twin (`engines/digitalTwin.js`)

`STATE(t0) → SHOCK → RESPONSE → LIQUIDATION → MARKET IMPACT → CONTAGION → STATE(t+n)`. The twin deep-freezes the snapshot, records its content hash, runs the cascade on **copies**, and re-hashes after every run (`assertSnapshotUnchanged`). Output = trajectory of states + stage trace. Steps are *cascade rounds*, not calendar days.

## M15 Causal / Counterfactual (`engines/counterfactual.js`)

Structural, model-based counterfactuals on the twin with the same seed: `Δ = Outcome(do(switch off channel c)) − Outcome(baseline)` for channels {margin, secondary-redemption, counterparty, common-asset overlap (disjointified holdings), impact scale ×½} and interventions (redemption gate, liquidity buffer). **This is NOT causal identification from observational data**; it states what the *model* implies. Status inherits the cascade's (UNCALIBRATED).

## M16 Uncertainty (`engines/uncertainty.js`)

* Seeded percentile bootstrap CI for any statistic.
* Beta–Binomial credible intervals for rates (precision, recall, FPR) with Jeffreys prior Beta(½,½) (objective, no tuning). Quantiles via regularized incomplete beta (continued fraction) + bisection.
* Rule-of-three upper bound `3/n` surfaced when zero events are observed.

## M20 Anomaly Ensemble (`engines/anomaly/`)

Detectors, each evaluated on `evaluation` points using only `reference` points that precede them:
| Detector | Equation | Convention params (UNCALIBRATED) |
|---|---|---|
| Robust z | `z = (x − med)/(1.4826·MAD)`; signal if `|z| > 3.5` | 3.5 (Iglewicz–Hoaglin) |
| EWMA chart | `z_t = λx_t + (1−λ)z_{t−1}`, limit `Lσ_z`, `σ_z² = σ²·λ/(2−λ)` | λ=0.2, L=3 (SPC textbook) |
| CUSUM | `S_t⁺ = max(0, S_{t−1}⁺ + z_t − k)`, signal `S⁺ > h` (and mirrored) | k=0.5, h=5 |
| Change-point | binary segmentation, mean-shift Gaussian cost with robust σ, BIC penalty `2σ²ln n` | penalty: BIC |
| Isolation Forest | `s(x,n)=2^{−E[h(x)]/c(n)}` (Liu et al. 2008); trained on the first 60% of the reference (time-ordered); **threshold = split-conformal quantile** `⌈(n_cal+1)(1−α)⌉`-th smallest score on the last 40% (α=0.01); `resolvable=false` when `n_cal+1 < 1/α` | 100 trees, ψ≤256, α=0.01 |
| LOF | Breunig et al. 2000 (novelty form), `k=20`; same time-ordered split and conformal threshold as above | k=20, α=0.01 |
**Aggregation (no averaging).** Output = per-model verdicts, `consensus = signals/available`, `disagreement = H_b(consensus)` (binary entropy), `coverage = available/total`. Unanimous SIGNAL ⇒ `SIGNAL`; unanimous NO ⇒ `NO_SIGNAL` (never `LOW_RISK`); mixed ⇒ `MODEL_DISAGREEMENT` listing both camps; `coverage < 0.5` ⇒ `INSUFFICIENT_DATA`.

## M30 Fundamental Reality (`engines/fundamentals.js`)

Reported quantities (each `UNOBSERVED` when inputs missing): margins; `CFO/NI`; FCF `= CFO − capex`; net debt/EBITDA; `DSO = AR/Rev·365`, `DIO = Inv/COGS·365`; net working capital; dilution `Δshares/shares` (split-adjusted share count required); revenue, EBITDA and CFO growth. Statements enter only at their **filing/publication time** (`available_time`), never period-end time.

## M31 Valuation (`engines/valuation.js`)

Multiples: EV/Sales, EV/EBITDA, P/E, P/B, P/FCF. Non-positive denominator ⇒ `NOT_MEANINGFUL` (not zero, not excluded silently). Peer-relative: `z = (ln m − med(ln m_peers))/(1.4826·MAD(ln m_peers))`, peers must be PIT and `≥ 5`; historical: percentile of current multiple within own trailing PIT history. Outputs a **valuation divergence measurement, never a "fair price"**.

## M32 Fundamental–Price Divergence (`engines/divergence.js`)

Over a window: `ΔlnMcap`, `Δln Rev`, `ΔCFO/Assets`, `ΔNetDebt/Assets`, dilution. Peer- and regime-adjusted: each series minus the peer cross-sectional median (peer-adjusted), market-cap change additionally minus index return (regime/market-adjusted). **Vector output**, never a single ratio. `DIVERGENCE_SUSPECTED` when residual market-cap move is a robust outlier (`z>3.5`) **and** ≥ 2 of 3 *observed* fundamental dimensions do not support it; unobserved dimensions are listed and never counted as "not supportive". UNCALIBRATED.

## M33 Accounting Quality (`engines/accountingQuality.js`)

Indicators: CFO−NI divergence; total accruals `TATA=(NI−CFO)/avgTA` (Sloan 1996); receivables-vs-revenue growth gap; inventory-vs-sales gap; margin anomalies (robust z vs own history); one-off income share; related-party revenue share; debt growth; dilution; auditor opinion signal (typed: unqualified / qualified / adverse / disclaimer / emphasis-of-matter — categorical, no scoring weights).
**Beneish 8-variable M-score** (Beneish 1999): `M = −4.84 + 0.920 DSRI + 0.528 GMI + 0.404 AQI + 0.892 SGI + 0.115 DEPI − 0.172 SGAI + 4.679 TATA − 0.327 LVGI`; published cut-off −1.78. Coefficients are published, estimated on US manufacturing 1982–1992: **UNCALIBRATED for BIST**. Any missing component ⇒ the index is `UNOBSERVED` and M is not computed (no neutral-1.0 imputation). **Statement in every output:** *No model, including this one, is evidence of fraud.* Output type is `ACCOUNTING_QUALITY_INDICATORS`.

## M40 Disclosure Intelligence (`engines/disclosure.js`)

Typed disclosure `{id, company, published_time, title, body?}` → rule-based event typing (versioned rule table, Turkish + English patterns): CONTRACT, INVESTMENT, CAPACITY_INCREASE, CAPITAL_INCREASE, SHAREHOLDER_SALE, AUDITOR_CHANGE, MANAGEMENT_CHANGE, PROJECT_CANCELLED, PROJECT_POSTPONED, FACILITY_OPENING. Rules are interpretable regexes; precision/recall unmeasured ⇒ UNCALIBRATED; a disclosure matching no rule is `UNCLASSIFIED` (not "benign").

## M41 Claim vs Reality (`engines/claimReality.js`)

Claim = `{claim_id, company, stated_time, type, deadline, expectation{metric?, promised?}}`. `evaluate(claim, evidence, asOf)` uses only evidence with `available_time ≤ asOf`:
```
phase PENDING (asOf < deadline, no resolving evidence) → INSUFFICIENT_EVIDENCE (reason DEADLINE_NOT_REACHED)
contradicting evidence (cancel / explicit negation)      → CONTRADICTED
confirming evidence at or before deadline                → CONFIRMED
confirming evidence after deadline                       → DELAYED
realized fraction f ∈ (0,1) of promised quantity         → PARTIALLY_CONFIRMED
deadline passed, source coverage adequate, nothing found → NOT_CONFIRMED
deadline passed, source coverage inadequate              → INSUFFICIENT_EVIDENCE
```
Every verdict returns `evidence_ids`, corroboration count (independent sources), and `rule` that fired.

## M50 Market Integrity / Pump-and-Dump Pattern (`engines/integrity.js`)

Stage features on window ordering `accumulation → acceleration → volume expansion → attention surge → distribution → collapse`, each activated by robust `z > 3.5` (or drawdown outlier) against the asset's own PIT reference window. `PatternSimilarity = (ordered stages observed) / 6`, where "ordered" requires stage start times non-decreasing; missing series (e.g., attention) ⇒ that stage `UNOBSERVED` and excluded from the denominator **with coverage reported**. Output kinds only: `PATTERN_SIMILARITY` or `MARKET_INTEGRITY_ANOMALY`. UNCALIBRATED. **Never** an accusation (text guard enforced in AI firewall and retail layer).

## M51 Attention / Promotion (`engines/attention.js`)

Per-asset attention series (news count, search index, open-source mention counts — permitted sources only) → robust z vs reference. `PROMOTION_MARKET_DIVERGENCE` = attention `z>3.5` ∧ return `z>3.5` ∧ volume `z>3.5` ∧ fundamentals **observed and not supportive**. Fundamentals unobserved ⇒ weaker label `ATTENTION_PRICE_VOLUME_CO_ANOMALY`. No individual-level profiling (aggregate counts only).

## M52 Coordinated Activity (`engines/coordination.js`)

Input: pseudonymous author key, timestamp, text. (1) Burst detection: bin counts vs Poisson rate from reference; tail p-value; Bonferroni across bins. (2) Temporal co-activity graph: accounts are active in `δ`-bins; the number of shared bins is tested against the **exact hypergeometric null** (both accounts post at uniformly random times), Bonferroni-corrected over all account pairs (α=0.01). (3) Semantic: character 5-gram shingle Jaccard ≥ τ_sim for near-duplicates. Output `COORDINATED_ACTIVITY_SUSPECTED` with cluster-level evidence (hashed IDs, sizes, p-values) — no names, no ranking of individuals; inputs containing identity fields are rejected.

## M60 Research Providers (`research/`)

Provider interface (`id, tier, search, isConfigured`). Tiers: `OFFICIAL_REGULATOR` (KAP, SPK, Borsa İstanbul) > `COMPANY_IR` > `INDEPENDENT_AUDIT` > `LICENSED_MARKET_DATA` > `NEWS_RELIABLE` > `NEWS_UNVERIFIED`. Each document carries `{source, publication_time|null, retrieval_time, content_hash}`. **Corroboration** = number of *distinct independent publishers* asserting the same claim key; `CORROBORATED` needs ≥ 2 independent publishers with ≥ 1 primary tier; otherwise `SINGLE_SOURCE` / `UNVERIFIED`.

## M70 Retail Alert Layer (`alerts/retailRiskTable.js`)

A 14-row table (price anomaly, volume anomaly, fundamental divergence, valuation divergence, liquidity, fund/portfolio concentration, KAP consistency, attention/promotion, insider/shareholder transactions, contagion, model disagreement, data coverage, uncertainty) of **status + measurement + evidence ids**. No composite score (a weighted sum would be an arbitrary coefficient), no BUY/SELL/HOLD.

## M80 Evidence Ledger / M90 Governance / M95 AI Firewall

Specified in ARCHITECTURE.md (they are infrastructure, not statistical models). Hash: SHA-256 over canonical JSON (sorted keys, no whitespace, numbers via `JSON.stringify`, `NaN/Infinity` rejected).

---

## Parameter registry (every non-derived constant)

| Parameter | Value | Provenance | Status |
|---|---|---|---|
| EWMA λ (vol) | 0.94 | RiskMetrics (1996) | UNCALIBRATED |
| Robust-z threshold | 3.5 | Iglewicz–Hoaglin 1993 | UNCALIBRATED |
| EWMA chart λ, L | 0.2, 3 | SPC textbook | UNCALIBRATED |
| CUSUM k, h | 0.5, 5 | SPC textbook | UNCALIBRATED |
| IForest trees, ψ, α | 100, 256, 0.01 | Liu 2008; target per-point false-alarm rate α with conformal threshold | UNCALIBRATED (α is a target, not a measured rate) |
| LOF k, α | 20, 0.01 | Breunig 2000; conformal threshold | UNCALIBRATED |
| Tail-count tolerance | 1e-9 | `⌈(1−α)N − 1e-9⌉` (floating-point guard) | n/a |
| Participation π | 0.20 | practitioner convention | UNCALIBRATED |
| Impact coefficient Y | *none* | caller must supply | UNCALIBRATED |
| Redemption β | *none* | caller or ESTIMATED | — |
| Beneish coefficients/cut | published | Beneish 1999 | UNCALIBRATED (BIST) |
| Cascade ε, r_max | 1e-9, 50 | numerical | n/a |
| Jeffreys prior | Beta(½,½) | objective prior | n/a |

A parameter not in this registry may not appear in an engine.
