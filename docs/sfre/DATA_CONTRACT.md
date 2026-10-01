# SFRE — Data Contract (v1.0.0)

## Observation (point-in-time unit)

```jsonc
{
  "id":            "obs_<hash prefix>",      // derived from content hash
  "entity":        "BIST:ABCD" | "FUND:XYZ",  // opaque id; no personal data
  "field":         "close" | "volume" | "revenue" | ...,
  "value":         123.4 | null,              // null = UNOBSERVED (never 0)
  "unit":          "TRY" | "shares" | ...,
  "event_time":     "ISO-8601 UTC",           // when the fact happened (e.g. period end, trade time)
  "published_time": "ISO-8601 UTC",           // when the source published it
  "available_time": "ISO-8601 UTC",           // when BQI could first have known it  (>= published_time)
  "ingested_time":  "ISO-8601 UTC",           // when BQI stored it                  (>= available_time)
  "source":         "kap" | "spk" | "bist" | "vendor:<name>" | "upload:<hash>" | ...,
  "revision":       0,                        // restatements increment; old revisions are never deleted
  "hash":           "sha256 of canonical content (all fields above except id, hash and ingested_time: re-importing the same fact dedupes)",
  "quality_flags":  ["ESTIMATED","RESTATED","STALE","SPLIT_UNADJUSTED", ...]
}
```

Validation (reject, never repair): all four times parse as UTC; `event_time ≤ published_time ≤ available_time ≤ ingested_time` is **not** required for `event_time` (period-end can precede) but `published_time ≤ available_time ≤ ingested_time` is mandatory; `value` is finite number, string, or `null`; `hash` recomputes; unknown `quality_flags` rejected. A **restatement** is a new observation with `revision+1`; as-of queries return the highest revision whose `available_time ≤ asOf`.

## Look-ahead firewall

`PitStore.asOf(T)` returns a view in which **only** observations with `available_time ≤ T` exist (strict `≤`; ties at `T` included, anything later is invisible, including later revisions of the same fact). The firewall is enforced at the *data access boundary*: engines receive a `PitView`, never the raw store, and a `PitView` for time `T` cannot be widened. Statements are available at **filing publication time**, never at period end. Backtests iterate `T` and may only call engines with `store.asOf(T)`; `assertNoFutureData(view, T)` is a runtime check run before every engine call in the validation lab.

## Immutable dataset snapshot

`createSnapshot(observations, {asOf})` → `{snapshot_id, asOf, count, content_hash, observations(frozen)}`. `content_hash = sha256(sorted observation hashes)`. Snapshots are deep-frozen; any attempted mutation throws in strict mode, and `verifySnapshot()` recomputes the hash. Snapshots are append-only artifacts: a new `asOf` or new revision produces a **new** snapshot id.

## Missing data semantics

* `value: null` or an absent observation ⇒ **UNOBSERVED**. Engines list it in `unobserved[]`.
* **UNKNOWN ≠ ZERO**: missing leverage, missing counterparty exposure, missing free-float, missing volume, missing redemption sensitivity are never defaulted.
* Engines return `coverage = observed_required / required` and a failure-semantic status (see ARCHITECTURE §Failure semantics). `LOW_RISK` is impossible when `coverage < 1` for any required input.

## Engine input shapes (typed, validated before computation)

* **FundSystem**: `{ currency, assets:[{id, price, adv_shares|null, sigma_daily|null, illiq|null, free_float_shares|null}], funds:[{id, nav?, cash, debt|null, margin_ratio|null, beta_redemption|null, holdings:[{asset, shares}], counterparty_claims:[{counterparty, amount|null}]}], impact:{model, Y?}}`
* **Series**: arrays of `{t, value}` already filtered through the firewall.
* **Statements**: filing-time-stamped, `{period_end, filed_time, revenue, ebitda, net_income, cfo, capex, total_assets, ... : number|null}`.
* **Disclosure**: `{id, company, published_time, retrieved_time, title, body?, source}`.
* **Posts** (coordination/attention): `{author_key (pseudonymous), time, text, asset}`; fields named like `name`, `email`, `phone`, `tckn`, `national_id`, `handle` are rejected.

## Provenance on every result

`{engine, model_id, model_version, calibration, parameters, parameter_hash, input_hashes[], snapshot_id, sources[]}` — see ARCHITECTURE §Evidence ledger.

## Real data availability (honest status, v1.0.0)

| Dataset | Needed for | Status in repo |
|---|---|---|
| Fund holdings (monthly/daily, TEFAS/KAP/SPK) | overlap, cascade | **MISSING** — no licensed/ingested feed |
| Fund flows / unit counts | redemption β | **MISSING** |
| Fund leverage / repo / derivative exposure | margin channel | **UNOBSERVED** (typically not public) |
| Counterparty exposure | counterparty channel | **UNOBSERVED** |
| BIST daily OHLCV + free float | microstructure, liquidity | **MISSING** (no licence) |
| Financial statements (KAP, filing-time) | fundamentals | **MISSING** |
| KAP disclosure archive | disclosure, claim engine | **MISSING** (no verified endpoint; provider is an unconfigured shell) |
| SPK bulletins / trading-ban lists | integrity golden cases | **MISSING** |
| Attention series (news/search) | attention | **MISSING** |
Synthetic generators in `validation/syntheticWorld.js` exist **only** to test the machinery; they are labelled `SYNTHETIC` in every output and are never used as evidence about real markets.
