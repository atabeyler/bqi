# BFI vNext — Systemic engines, Market Surveillance 2.0 and the Financial System Digital Twin

Status: **all models below are `DEVELOPMENT`, `UNCALIBRATED`, `NON_PRODUCTION`.** They are scenario and pattern-similarity models. Synthetic tests prove internal consistency (conservation identities, known answers, independent cross-checks, determinism); they do **not** prove predictive validity. No code path promotes a model; promotion follows the existing governance lifecycle (`governance/modelRegistry.js`).

Nothing here rewrites an existing engine. New code lives in `server/src/sfre/engines/systemic/` and `engines/surveillance/`; it **reuses** `impact.js` (M07 price impact), `leverage.js` (M06 margin sale), `concentration.js` (M02 HHI), `overlap.js` (M03), `microstructure`/`anomaly` statistics, `coordination.js` (hypergeometric test, union-find), `cascade.js` (M10, still the fund-level engine) and `digitalTwin.js` (extended, not replaced).

## 1. Common contract (every new engine)

| Standard | Implementation |
|---|---|
| deterministic / seeded | no `Math.random`; Monte Carlo uses `core/prng.js` child streams; same inputs + seed ⇒ same `result_hash` (tested for every engine) |
| PIT / look-ahead | `request.systemic.asOf` and `request.surveillance.asOf` are required; later than `request.asOf` ⇒ rejected; surveillance events later than `asOf`, or reference not strictly earlier than evaluation ⇒ rejected |
| missing ≠ zero | `null`/omitted `externalAssets`, `externalLiabilities`, exposure amounts, PD/LGD, hedge ratios, sensitivities, impact inputs, IM posted … are `UNOBSERVED`: listed in `unobserved`, the channel is excluded, status becomes `INSUFFICIENT_OBSERVABILITY`, results are flagged `lowerBound` (or `upperBoundReasons` where the missing term is a resilience term) |
| coverage | `coverage = determinate entities / entities` (or pools, nodes, agents) |
| calibration state | always `UNCALIBRATED` here; `LOW_RISK` cannot be constructed (envelope invariant) |
| uncertainty | `core/sensitivity.js` seeded Latin-hypercube band over the **assumed** parameters (`LATIN_HYPERCUBE_ASSUMPTION_BAND`); M65 additionally reports seeded Monte-Carlo dispersion and CI of the mean. These are sensitivity bands, **not** confidence intervals of real-world outcomes (the note says so) |
| model/version registry | `M60…M71` registered at `DEVELOPMENT` (`spec_ref` → this document) |
| result/input hashes | `makeResult` hashes; `input_hashes` carry `hashOf(system section)`; run record gets `systemicInputHash` |
| evidence chain | results go through `EvidenceLedger.recordClaim` unchanged (`CLAIM→ENGINE_RUN→MODEL→PARAMETERS→INPUT`) |
| explicit assumptions | `parameters.assumptions` / `parameters.*Basis`; `GET /api/sfre/capabilities` serves needs, assumptions, limitations per engine |
| fail loudly | invalid input ⇒ `COMPUTATION_FAILED` with a message; unknown scenario keys, scenario keys without their system section, identity fields, attack probabilities are rejected, never ignored |

### Shared state (`systemic/state.js`)
`system = {assets, impact, entities, exposures, …engine sections}`. One entity/exposure network is shared by every engine. Sectors: `BANK, FUND, INSURER, CORPORATE, SOVEREIGN, HOUSEHOLD, FOREIGN_INVESTOR, CCP, PRIVATE_CREDIT, STABLECOIN, DEFI, SERVICE_PROVIDER, OTHER`. Entity: `cash ≥ 0` (explicit), `holdings[{asset, shares, book: MARKET|HTM}]`, `creditBook[{amount, pd|null, lgd|null, riskSector, …}]`, `externalAssets|null`, `externalLiabilities|null`; exposures: `{creditor, debtor, amount|null, kind, currency: LCY|FCY, fxHedged}`.

### Clearing (`systemic/clearing.js`)
Rogers–Veraart clearing (Eisenberg–Noe for α=β=1): `p_i = L̄_i` if `e_i + Σ_j π_ji p_j ≥ L̄_i`, else `α e_i + β Σ_j π_ji p_j`; monotone iteration from full payment gives the greatest clearing vector; each entity has a default **wave** (round of first default). Independent reference: default-set iteration + Gaussian elimination (`crosscheck/reference_systemic.py`), agreement ≤ 1e-7 on 40 random networks.
Value conservation (checked every call): `Σ equityLoss + outsideCreditorLoss = directLoss + deadweight`.

## 2. Engines

**M60 Cross-sector stress** — banks, funds, insurers, corporates, sovereign, households and foreign investors on one network; shocks (`priceShocks`, `externalShocks`, `sectorShocks`) propagate through 2nd, 3rd … default waves; output: waves, sector transmission matrix (debtor sector → creditor sector shortfall), amplification, identity residual. Assumptions: limited liability, pro-rata payment, α/β (default 1 = no bankruptcy costs, labelled `ASSUMED`).

**M61 FX & cross-border contagion** — capital flow `φ·(portfolio)` → FCY demand `D = flow + Σ max(0, STD(1−rollover) − liquid FCY)`; official supply `S = reserves·usableShare + swaps`; excess `X = max(0, D − S)`; depreciation `d = d_exo + min(1, Y σ √(X/ADV))` (reuses the M07 sqrt model, `Y` has no default); FX balance-sheet effect `d·FCYassets − d·FCYliab·(1−hedge)`; FCY exposures revalued for both counterparties; PD shift `Φ(Φ⁻¹(pd) + s·d·fxExposure)`; contagion through M60. Missing hedge ratio ⇒ point estimate assumes full hedge (lower bound) and `upperBoundHedgeLoss` is reported.

**M62 Sovereign–bank–corporate nexus** — price factor `1 − D·Δy + ½·C·Δy²` (HTM not recognised in accounting capital); bank capital ratio and shortfall; funding-cost pass-through `ρΔy + λ·shortfall/RWA`; corporate PD `Φ(Φ⁻¹(pd) + φ·Δc·D/EBITDA + φ_cc·crunch)`; corporate earnings hit; backstop `β·Σ shortfall` raises debt, growth hit lowers GDP, spread feedback `κ·Δ(debt/GDP)`; fixed point on Δy (≤200 iterations; non-convergence ⇒ `MODEL_UNCERTAIN`). Any sensitivity left `null` is excluded and flagged. Accepts `pre` (losses already booked by other engines) so the loop sees total bank losses.

**M63 Margin / repo / collateral** — IM `z_q σ_ns √MPOR` (modes `NO_OFFSET` default, `INDEPENDENT`, `MATRIX`); VM = exposure × price move; repo call `max(0, cash − V(1−h'))`; eligibility and substitution order (non-cash eligible assets first, cash last unless a caller order is supplied); calls paid from cash/eligible collateral, remainder by fire sales of unencumbered holdings (price impact via M07), margin default if exhausted; margin loans reuse M06 `marginSaleRequired`; counterparty exposure `E[max(0,a+bx)] = aΦ(a/b)+bφ(a/b)` and wrong-way expected loss `∫E(x)·LGD·Φ((Φ⁻¹(pd)+√ρ x)/√(1−ρ))φ(x)dx` (ρ>0 wrong-way). Cross-checked by midpoint quadrature in Python.

**M64 CCP waterfall** — loss = price-move loss + close-out cost (`|e|·d(|e|)`, conservative); layers: defaulter IM → defaulter DF → skin-in-the-game → survivors' DF (pro rata) → assessments (cap × DF) → unfunded; survivors whose charges exceed capital default next round; HHI of IM, cover-2 test.

**M65 Private credit / shadow banking** — two-level Vasicek factor model (global ρ_g, sponsor ρ_s). Analytic stressed loss `Σ EAD·LGD·Φ((Φ⁻¹(pd) − √ρ_g g)/√(1−ρ_g))`; seeded Monte Carlo gives dispersion (sponsor clustering ⇒ fatter tail). Fund balance sheet: credit loss → LTV covenant (`Δ = (D − cA)/(1 − c/(1−δ))`, forced sales at discount δ) → unfunded draws + redemptions with gating and facility draws. Transmission: lenders' claims (network), insurer/bank stakes (`stake × equity loss`), gated redemptions as investor inflow lost.

**M66 AI crowding / algorithmic herding** — unit-norm loading rows X; effective independent strategies `N_eff = (tr G)²/‖G‖_F²`, `G = XXᵀ` (participation ratio; identical agents ⇒ 1); model/data-vendor HHI; position overlap (M03). Orders `G_i·κ·(Σ_s load_is shock_s)·w_ia`; herding ratio `|ΣQ|/√ΣQ²`; impact on net flow (M07); stop-loss deleveraging iterates the cascade. Says nothing about whether any real participants share these signals.

**M67 Cyber & operational contagion** — dependency graph (cloud/data/trading/settlement/payment/service/institution); outage scenario (`node`, `durationHours`) ⇒ unavailable fraction; propagation `u_n = 1 − (1−u_direct)·Π(1 − crit·u_eff)` with substitution `u_eff = (1−r)u + r·min(u, max(failover/H, u_alt))`; payment/settlement failures `valuePerDay·H/24·u`; liquidity gap increments; margin-delivery failures reported; single-point-of-failure sweep. **No attack/hack/failure probability is produced or accepted** (any such key is rejected loudly).

**M68 Climate & nature** — transition cost `P_c·intensity·(1−abatement)(1−passThrough)`, nature revenue loss `1 − Π(1 − dep·degradation)`, EBITDA drop `(cost+loss)/margin` (cap 1), valuation haircut `passThrough·drop`, PD shift `γ·drop` (probit), physical damage `damage·physicalShare` split insured/uninsured, insurer losses from insured value. Output feeds asset prices, creditBook PDs, corporate assets and insurers.

**M69 Digital assets** — stablecoin run with **sequential service** (cash → deposits → marketable reserves; remaining holders pro rata ⇒ post-run peg), constant-product AMM (`x·y=k`, exact fee handling, optimal marginal-price split), DeFi liquidation cascades on AMM-priced collateral (health factor, close factor, penalty, bad debt), oracle deviation and bridge backing ratio, liquidity fragmentation (`reachable` depth), on-chain contagion through the shared network. Run size, oracle deviation and bridge loss are scenario inputs.

## 3. Market Surveillance 2.0 (M70)

Seven detectors over pseudonymous message streams (`NEW/CANCEL/MODIFY/TRADE`), reference window strictly before the evaluation window, Bonferroni control over the tested groups, salted-hash participant keys, identity fields rejected, all findings labelled "…_LIKE_PATTERN" with the non-allegation disclaimer. `NO_SIGNAL` is never evidence of compliance; tiny references give `INSUFFICIENT_DATA`.

| Detector | Statistic |
|---|---|
| spoofing | large (reference q95) order, cancelled < τ, unfilled, followed by opposite-side execution; Poisson tail vs pooled reference episode rate |
| layering | ≥L same-side orders at distinct levels cancelled together + opposite execution; Poisson tail |
| wash/self trading | same-owner crosses (owner key / owner groups) and offsetting round trips (rule based) |
| marking the close | participant's close-window volume fraction vs its own reference days (robust z), aligned with the window move |
| cancellation / book anomalies | quasi-binomial (dispersion-adjusted) tests of cancel share, short-lifetime share, order-to-trade ratio vs pooled reference; message-burst Poisson tail; market-wide cancel-ratio series through the existing anomaly ensemble |
| cross-venue / cross-market | cancelled large orders in one instrument + opposite executions in a declared linked instrument; seeded permutation test |
| coordinated trading | same instrument/direction co-activity in time bins, hypergeometric null (M52 machinery), clusters ≥3 |

The summary result lists signalling detectors and **corroborating references** to existing M50/M51/M52/M20 results of the same run (listed, not merged; agreement is not independent confirmation).

## 4. Financial System Digital Twin (M71)

`FinancialSystemDigitalTwin extends FinancialDigitalTwin` (fund-level `run()` unchanged; snapshot frozen and re-hashed around every run). Pipeline per round:

`SHOCK → BALANCE-SHEET EFFECT → FUNDING/LIQUIDITY → MARGIN/COLLATERAL → FORCED ACTION → MARKET IMPACT → COUNTERPARTY/NETWORK CONTAGION → SECOND-ROUND EFFECTS → STATE(t+n)`.

Hand-offs (also in `value.dataflow`): climate haircuts and PD losses → price vector/balance sheets → **M62 sees them as pre-applied bank losses**; FX roll-over gaps, facility draws, stablecoin deposit withdrawals and operational liquidity gaps → funding need → forced sales; live prices → variation margin/haircut calls (M63) → fire sales; one **aggregate** market impact per asset per round from all sellers (entities, collateral, external flows, crowding); clearing defaults + margin defaults → CCP waterfall → survivor charges → next-round balance sheets; crowding stop-losses follow the live price path. An optional `fundSystem` keeps running through the existing M10 cascade, coupled through the price vector (fund-caused decline composed multiplicatively — documented assumption). A module runs only when both its system section and its scenario key exist.

Ledger: `directLoss = holdings price loss (exogenous / impact / fund) + non-market haircuts + cash settlements + Σ(−ΔA_engine) + Σ ΔL_engine + IM claims + repo/CCP/agent losses`, reconciled to the clearing engine to floating-point tolerance every run; failure ⇒ `COMPUTATION_FAILED`.

Documented simplifications: sales execute at start-of-round marks; crowding buy-side flows ignored; operational margin failures reported not propagated; unpaid margin obligations stay as liabilities; DF contributions assumed carried in external assets.

## 5. API / UI

`POST /api/sfre/runs` accepts engines `crossSector, fxContagion, sovNexus, collateral, ccp, privateCredit, aiCrowding, opContagion, climate, digitalAssets, systemTwin, surveillance` with `systemic: {asOf, system, scenario, options}` and `surveillance: {asOf, referenceEvents, events, …}`; `surveillance` and `systemTwin` run last. `GET /api/sfre/capabilities` returns needs/assumptions/limitations and live governance state. The BFI console has a **Systemic** tab (capability cards + twin stage walk-through on a synthetic sample).

## 6. What real data / calibration is required before any non-scenario use

* Balance sheets and bilateral exposures (supervisory/BIS-IBSI/TR sources), holdings by security, HTM/AFS split, funding profiles and deposit run-off histories.
* FX: official reserve usability, swap lines, FCY maturity ladders, hedge ratios, FX market depth → estimate `Y`, `σ`, `ADV`, pass-through.
* Sovereign nexus: pass-through, PD sensitivity and spread–debt elasticity from episodes; bond duration/convexity per holder.
* Margin/CCP: actual IM models and haircut schedules, netting sets, CCP waterfall rules, member capital; WWR correlations.
* Private credit: loan-level PD/LGD, sponsor mapping, covenant and gating terms, redemption histories.
* Crowding: evidence of shared signals/vendors; response scale; stop-loss rules.
* Operational: provider dependency maps, failover times, payment-flow volumes.
* Climate/nature: sector emission intensity, margins, physical-asset shares, insurance coverage, ENCORE-type dependencies; transmission elasticities.
* Digital: reserve composition attestations, on-chain positions/oracles/bridges.
* Surveillance: labelled real order-book episodes (≥30 confirmed positives per pattern, locked hold-out) to calibrate thresholds; until then thresholds stay `UNCALIBRATED`.
* Governance: per model, a real-data validation report, shadow period, negative controls and a distinct human approver (existing rules).

## 7. Pre-merge audit notes (b77c8ac)

Corrected after audit (regression tests in `tests/vnextAudit.test.js`):
* **Funding stage booked asset-swap cash flows as liability repayments** (facility draws, edge-booked deposit withdrawals) and so created equity; now only payments that settle an outside liability reduce liabilities.
* **Negative external balance was clipped to zero** inside the clearing input (value destroyed silently, identity broken); the net external position is now preserved (a negative asset balance becomes an outside liability and vice versa).
* **Investor stake losses were counted again as value destroyed** next to the fund's own asset loss; they are now *transfers* (`transferDelta`): equity effect for the investor, not additional system loss.
* **CCP**: variation margin already paid by a member is netted from its close-out loss; the defaulter's IM/DF consumed by the waterfall is removed from its assets; unpaid CCP margin is no longer also booked as a liability of the defaulter when the CCP module is active.
* **M62** diverging feedback (GDP wiped out / unbounded spread) no longer yields non-finite output; it stops at the last finite iterate and is `MODEL_UNCERTAIN`.
* Silent defaults removed (now `UNOBSERVED` + `lowerBound`): omitted collateral haircut, omitted AMM pool fee, omitted CCP member positions, omitted bank funding profile, null bond convexity, null corporate RWA share, omitted wrong-way LGD.
* Surveillance sessions closing after `asOf` are rejected (nested look-ahead); string tie-breaks use codepoint order instead of the host locale.
* `fx.entities` must list only **non-network** FCY positions; FCY loans present in `exposures` are revalued through the edges.

## 8. Credit Risk Shock Aggregator (`engines/systemic/creditShocks.js`)

Engines no longer stress PDs. M61 (FX), M62 (sovereign funding cost / credit crunch), M68 (climate/nature) and M65 (systematic factor) emit `creditShockContribution`s `{source, shockId, entity, book, kind, magnitude, transformation, inputs}`; the aggregator is the only place where a creditBook PD is stressed and where the expected-credit-loss increment is derived and booked (M71 books it once and attributes it to the source engine's ledger channel).

For a row with base PD `p0` (preserved, `z0 = Φ⁻¹(p0)`):

```
z_pre   = z0 + Σ_k δ_k                         over de-duplicated PROBIT_SHIFT contributions
z_final = f_m(…f_1(z_pre)),  f(z) = (z − √ρ·g)/√(1−ρ)   FACTOR contributions (M65), applied in shockId order
PD      = Φ(z_final) ∈ [0,1]            ΔEL = EAD · LGD · (PD − p0)
attribution_k = δ_k · ΔEL / Σδ          (Aumann–Shapley along z0→z_final; Σδ→0: δ_k·EAD·LGD·φ(z0))
```

* **De-duplication:** contributions with the same `(book, shockId)` are one economic shock; the largest `|magnitude|` is applied (ties by source name), the rest stay in the provenance as `applied:false, deduplicatedInto`.
* **Missing vs zero:** `observed:false` contributions are listed (`credit_shock:<source>:<entity>:<book>`), flag the book `incomplete` and apply nothing; an observed contribution with magnitude 0 is a real "no shock". Missing base PD/LGD ⇒ `credit_book_inputs:…`.
* **Why not `PD += shock`:** additive PD shocks are not bounded (PD>1 or <0 for large/negative shocks), are order/ordering-of-booking dependent when each engine mutates the PD in turn, and ignore that PD responds convexly to a common latent factor, so two shocks that each look small add more than the sum of their separately booked losses; the latent-space sum is bounded by construction, associative and commutative, and keeps offsetting shocks offsetting.
* PIT: a contribution with `availableAt` later than the aggregation `asOf` is rejected (`look-ahead guard`); engines derive theirs from the request already bounded by `systemic.asOf`.
* Private-credit loans: other engines' shifts enter first, M65's factor is applied on top; M65 books those loans itself (absolute stressed loss), so the central aggregator skips booking them (`excludedFromBooking`) but still reports their provenance (`credit.fundBooks`).
* Limitation: shifts from different engines are assumed additive in latent space (no interaction terms); sensitivities remain caller-supplied and UNCALIBRATED.
