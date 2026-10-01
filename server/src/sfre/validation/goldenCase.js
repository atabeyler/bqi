import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseTime } from '../data/observation.js';
import { assertNoFutureData } from '../data/pitStore.js';
import { rateInterval } from '../engines/uncertainty.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'goldenCases');
const FORBIDDEN_KEYS = ['learned_threshold', 'trained_on_event', 'post_event_features', 'outcome_parameters'];
export const VERDICTS = Object.freeze({ RELEASE_FAILURE: 'RELEASE_FAILURE', FALSE_ALARM_BUDGET_EXCEEDED: 'FALSE_ALARM_BUDGET_EXCEEDED', BLOCKED_NO_DATA: 'BLOCKED_NO_DATA', PASSED: 'PASSED', SYNTHETIC_HARNESS_PASS: 'SYNTHETIC_HARNESS_PASS' });

export function loadGoldenCase(id) { return JSON.parse(readFileSync(path.join(DIR, `${id}.json`), 'utf8')); }
export function loadMarketIntegrityRegistry() { return JSON.parse(readFileSync(path.join(DIR, 'market-integrity.registry.json'), 'utf8')); }

/** A golden case must be blind: no outcome-derived parameters anywhere in the spec. */
export function validateGoldenCaseSpec(spec) {
  const errs = [];
  if (spec.blind !== true) errs.push('case must declare blind:true');
  const walk = (o, p = '') => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (FORBIDDEN_KEYS.includes(k)) errs.push(`outcome-derived key "${p}${k}"`); walk(v, `${p}${k}.`); } };
  walk({ ...spec, forbidden_in_model_inputs: undefined, scoring: undefined });
  return errs;
}

function precursorCoverage(view, spec) {
  const req = spec.evaluation.required_precursors;
  const rows = req.map((r) => {
    const horizon = view.asOfMs - r.lookback_days * 86400000;
    const n = view.observations.filter((o) => o.field === r.field && o.entity.startsWith(r.entity_prefix) && o.value !== null && parseTime(o.event_time) >= horizon).length;
    return { field: r.field, observed: n, required: r.min_observations, ok: n >= r.min_observations };
  });
  return { rows, fraction: rows.filter((r) => r.ok).length / rows.length };
}

/**
 * Strict point-in-time blind replay. evaluator(view, T) -> {entity: boolean alarm}.
 * Only store.asOf(T) for T strictly before event_time is ever read. Missing real data => BLOCKED_NO_DATA (never a pass).
 */
export function replayBlind({ spec, store, evaluator, eventEntities = spec.event_entities, controlEntities = [], dataKind = 'REAL' }) {
  const specErrs = validateGoldenCaseSpec(spec);
  if (specErrs.length) return { verdict: VERDICTS.BLOCKED_NO_DATA, reason: `invalid spec: ${specErrs.join('; ')}` };
  if (!spec.event_time) return { verdict: VERDICTS.BLOCKED_NO_DATA, reason: 'EVENT_FACTS_NOT_CONFIRMED_FROM_PRIMARY_SOURCE' };
  if (!eventEntities?.length) return { verdict: VERDICTS.BLOCKED_NO_DATA, reason: 'EVENT_ENTITIES_NOT_SUPPLIED' };
  if (spec.data_kind_required === 'REAL' && dataKind !== 'REAL' && dataKind !== 'SYNTHETIC') return { verdict: VERDICTS.BLOCKED_NO_DATA, reason: 'unknown data kind' };
  const eventMs = parseTime(spec.event_time);
  const horizonMs = spec.evaluation.pre_event_horizon_days * 86400000; const gap = spec.evaluation.gap_days * 86400000;
  const lastView = store.asOf(eventMs - gap);
  const cov = precursorCoverage(lastView, spec);
  if (cov.fraction < spec.evaluation.min_required_coverage) return { verdict: VERDICTS.BLOCKED_NO_DATA, reason: 'INSUFFICIENT_PRECURSOR_COVERAGE', coverage: cov };
  if (controlEntities.length < spec.evaluation.healthy_controls.min_count) return { verdict: VERDICTS.BLOCKED_NO_DATA, reason: 'INSUFFICIENT_HEALTHY_CONTROLS', controls: controlEntities.length, required: spec.evaluation.healthy_controls.min_count, coverage: cov };
  const step = 7 * 86400000; const alarms = {}; const all = [...eventEntities, ...controlEntities];
  for (const e of all) alarms[e] = [];
  for (let T = eventMs - horizonMs; T < eventMs - gap + 1; T += step) {
    const view = store.asOf(T); assertNoFutureData(view, T);
    const out = evaluator(view, T);
    for (const e of all) alarms[e].push({ t: T, alarm: !!out[e] });
  }
  const first = (e) => alarms[e].find((x) => x.alarm)?.t ?? null;
  const leads = eventEntities.map((e) => ({ entity: e, firstAlarm: first(e), leadDays: first(e) === null ? null : (eventMs - first(e)) / 86400000 }));
  const caught = leads.filter((l) => l.firstAlarm !== null).length;
  const falseAlarmEntities = controlEntities.filter((e) => first(e) !== null).length;
  const far = rateInterval(falseAlarmEntities, controlEntities.length);
  const budget = spec.evaluation.false_alarm_budget_per_entity;
  const base = { coverage: cov, leads, eventCaught: caught, eventTotal: eventEntities.length, controlFalseAlarmRate: far, budget, dataKind };
  if (caught === 0) return { verdict: VERDICTS.RELEASE_FAILURE, reason: 'sufficient precursor data, no alarm before event', ...base };
  if (far.point > budget) return { verdict: VERDICTS.FALSE_ALARM_BUDGET_EXCEEDED, ...base };
  return { verdict: dataKind === 'REAL' ? VERDICTS.PASSED : VERDICTS.SYNTHETIC_HARNESS_PASS, ...base };
}

/** Market-integrity cases: refuses to evaluate against an empty registry. */
export function replayMarketIntegrity(registry = loadMarketIntegrityRegistry()) {
  if (!registry.cases.length) return { verdict: VERDICTS.BLOCKED_NO_DATA, reason: 'REGISTRY_EMPTY: no verified point-in-time market-integrity cases available', cases: 0 };
  return { verdict: VERDICTS.BLOCKED_NO_DATA, reason: 'case replay requires per-case PIT data loader (not configured)', cases: registry.cases.length };
}
