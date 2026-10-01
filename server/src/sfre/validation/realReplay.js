import { readFileSync } from 'node:fs';
import { makeFeatureExtractor } from './fragilityAlarm.js';
import { replayBlind, loadGoldenCase } from './goldenCase.js';
import { parseTime } from '../data/observation.js';
import { quantile } from '../core/stats.js';

const DAY = 86400000;

/** Operator-supplied, PRIMARY-SOURCE-confirmed event facts (e.g. from the SPK decision). Never inferred by SFRE. */
export function loadConfirmedFacts(file) {
  const f = JSON.parse(readFileSync(file, 'utf8'));
  const errs = [];
  if (Number.isNaN(parseTime(f.event_time))) errs.push('event_time must be ISO-8601 UTC');
  if (!Array.isArray(f.event_entities) || !f.event_entities.length || f.event_entities.some((e) => !String(e).startsWith('FUND:'))) errs.push('event_entities must be a non-empty list of FUND:<code>');
  if (!f.source_url || !f.confirmed_by) errs.push('source_url and confirmed_by (primary source + person) are required');
  if (errs.length) throw new Error(`invalid confirmed facts: ${errs.join('; ')}`);
  return f;
}

/**
 * Blind replay on a real (or synthetic, via dataKind) PIT store.
 * The alarm rule's single fitted parameter (fragility-change threshold) is fitted UNSUPERVISED on dates strictly before the evaluation
 * window using all funds (event labels are never used), then frozen. Rule = 28d fragility change > threshold AND >=1 flow-anomaly signal.
 */
export function runRealReplay({ store, confirmed, spec = loadGoldenCase('TR-FUND-2026-001'), dataKind = 'REAL', quantileLevel = 0.95 }) {
  const eventMs = parseTime(confirmed.event_time);
  const merged = { ...spec, event_time: confirmed.event_time, event_entities: confirmed.event_entities };
  const horizon = spec.evaluation.pre_event_horizon_days * DAY; const gap = spec.evaluation.gap_days * DAY;
  const last = store.asOf(eventMs - gap);
  const assetIds = last.entities('BIST:').filter((e) => last.latest(e, 'close'));
  const fundIds = last.entities('FUND:').filter((e) => last.latest(e, 'holdings'));
  const controls = fundIds.filter((f) => !confirmed.event_entities.includes(f));
  const ex = makeFeatureExtractor(store, assetIds, fundIds);
  // unsupervised threshold fit on the pre-window period (4 weekly dates ending at window start - gap)
  const fitEnd = eventMs - horizon - gap; const dChange = [];
  for (let k = 0; k < 8; k++) { const T = fitEnd - k * 7 * DAY; for (const f of Object.values(ex.featuresAt(T))) if (f.dFrag !== null) dChange.push(f.dFrag); }
  if (dChange.length < 50) return { verdict: 'BLOCKED_NO_DATA', reason: 'INSUFFICIENT_PRE_WINDOW_DATA_FOR_UNSUPERVISED_THRESHOLD', samples: dChange.length };
  const theta = quantile(dChange, quantileLevel);
  const evaluator = (view, T) => { const out = {}; for (const [id, f] of Object.entries(ex.featuresAt(T))) out[id] = f.dFrag !== null && f.flowSig !== null && f.dFrag > theta && f.flowSig >= 1; void view; return out; };
  const res = replayBlind({ spec: merged, store, evaluator, eventEntities: confirmed.event_entities, controlEntities: controls, dataKind });
  return { ...res, rule: { fragilityChangeThreshold: theta, thresholdQuantile: quantileLevel, flowMin: 1, fittedOn: 'unlabelled pre-window dates only' }, confirmed: { source_url: confirmed.source_url, confirmed_by: confirmed.confirmed_by } };
}
