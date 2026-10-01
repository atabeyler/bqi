import { describe, it, expect } from 'vitest';
import { classificationMetrics, prAuc, brier, ece, leadTimes, alarmStability, fitLogistic, thresholdForFpr } from '../validation/metrics.js';
import { makeFolds, walkForward, LockedHoldout, HoldoutBurnedError, permutationControl, ablation, sensitivity, regimeRobustness, championChallenger } from '../validation/protocols.js';
import { loadGoldenCase, loadMarketIntegrityRegistry, validateGoldenCaseSpec, replayBlind, replayMarketIntegrity, VERDICTS } from '../validation/goldenCase.js';
import { generateWorld } from '../validation/syntheticWorld.js';
import { makeFeatureExtractor, systemFromView } from '../validation/fragilityAlarm.js';
import { runSyntheticValidation } from '../validation/runSynthetic.js';
import { PitStore, LookAheadError } from '../data/pitStore.js';
import { Rng } from '../core/prng.js';
import { obs, T0, DAY, iso } from './helpers.js';

describe('metrics', () => {
  it('confusion metrics + intervals; accuracy is not the headline', () => {
    const labels = [true, true, false, false, false, false]; const alarms = [true, false, true, false, false, false];
    const m = classificationMetrics(labels, alarms);
    expect([m.tp, m.fp, m.tn, m.fn]).toEqual([1, 1, 3, 1]); expect(m.precision.point).toBe(0.5); expect(m.recall.point).toBe(0.5); expect(m.fpr.point).toBe(0.25); expect(m.fnr.point).toBe(0.5);
    expect(m.fpr.lo).toBeLessThan(0.25); expect(m.fpr.hi).toBeGreaterThan(0.25); expect(m).not.toHaveProperty('accuracy');
  });
  it('PR-AUC reuses the repo implementation: perfect ranking -> 1, reversed -> low', () => {
    expect(prAuc([true, true, false, false], [0.9, 0.8, 0.2, 0.1])).toBeCloseTo(1, 12); expect(prAuc([true, true, false, false], [0.1, 0.2, 0.8, 0.9])).toBeLessThan(0.5);
  });
  it('Brier and ECE known answers', () => {
    expect(brier([1, 0], [true, false])).toBe(0); expect(brier([0.5, 0.5], [true, false])).toBeCloseTo(0.25, 12);
    expect(ece([0.9, 0.9, 0.9, 0.9], [true, true, true, false], 1)).toBeCloseTo(0.15, 12); expect(ece([1, 0], [true, false], 2)).toBe(0);
  });
  it('lead time (first alarm in horizon; missed -> null) and alarm stability', () => {
    const al = { A: [{ t: 1, alarm: false }, { t: 5, alarm: true }, { t: 8, alarm: true }], B: [{ t: 5, alarm: false }] };
    const lt = leadTimes([{ entity: 'A', event_time: 10 }, { entity: 'B', event_time: 10 }], al, 9);
    expect(lt[0].leadMs).toBe(5); expect(lt[1].leadMs).toBeNull();
    expect(alarmStability({ A: [{ t: 1, alarm: false }, { t: 2, alarm: true }, { t: 3, alarm: false }, { t: 4, alarm: false }] }).flipRate).toBeCloseTo(2 / 3, 12);
  });
  it('logistic calibration is monotone; FPR threshold uses negatives only', () => {
    const scores = Array.from({ length: 200 }, (_, i) => i / 200); const labels = scores.map((s) => s > 0.7);
    const lg = fitLogistic(scores, labels); expect(lg.predict(0.9)).toBeGreaterThan(lg.predict(0.2));
    expect(thresholdForFpr(scores, labels, 0.1)).toBeCloseTo(0.6, 1);
  });
});

describe('protocols', () => {
  it('folds: purge removes label-overlapping training samples; train always precedes test', () => {
    const f = makeFolds({ n: 40, initialTrain: 10, testSize: 5, purge: 3 });
    for (const x of f) { expect(Math.max(...x.trainIdx)).toBeLessThan(Math.min(...x.testIdx) - 2); expect(x.trainIdx[0]).toBe(0); }
    const rolling = makeFolds({ n: 40, initialTrain: 10, testSize: 5, mode: 'rolling', window: 6 });
    expect(rolling[1].trainIdx).toHaveLength(6);
  });
  it('walk-forward: the firewall is asserted before each score call; leaking stores are caught', () => {
    const s = new PitStore(); for (let d = 0; d < 20; d++) s.add(obs({ t: T0 + d * DAY, value: d }));
    const times = Array.from({ length: 20 }, (_, d) => T0 + d * DAY); const folds = makeFolds({ n: 20, initialTrain: 10, testSize: 5, purge: 0 });
    const seen = [];
    walkForward({ store: s, times, folds, fit: (tt) => ({ n: tt.length }), score: (m, view, T) => { seen.push(view.latest('BIST:AAAA', 'close').value * DAY + T0 <= T + 1); return {}; } });
    expect(seen.every(Boolean)).toBe(true);
    expect(() => walkForward({ store: s, times, folds: [{ trainIdx: [0, 1, 2, 12], testIdx: [10, 11] }], fit: () => ({}), score: () => ({}) })).toThrow(/overlap/);
  });
  it('locked holdout: second evaluation burns it', () => {
    const h = new LockedHoldout({ ids: ['a', 'b'], periodStart: 1, periodEnd: 2 });
    expect(h.evaluate((ids) => ids.length).result).toBe(2); expect(() => h.evaluate(() => 1)).toThrow(HoldoutBurnedError); expect(h.burned).toBe(true); expect(h.lock_hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('NEGATIVE CONTROL: label permutation -> a skilful score passes, a random score does not', () => {
    const rng = new Rng(1); const labels = Array.from({ length: 400 }, (_, i) => i % 20 === 0);
    const good = labels.map((y) => (y ? 0.8 : 0.3) + 0.1 * rng.next()); const noise = labels.map(() => rng.next());
    expect(permutationControl({ labels, scores: good, rng: new Rng(2), B: 100 }).passed).toBe(true);
    const c = permutationControl({ labels, scores: noise, rng: new Rng(3), B: 100 }); expect(c.passed).toBe(false); expect(c.pValue).toBeGreaterThan(0.05);
  });
  it('ablation / sensitivity / regime robustness / champion-challenger shapes', () => {
    const a = ablation(['x', 'y'], (d) => ({ prAuc: 1 - 0.2 * d.size - (d.has('x') ? 0.3 : 0) })); expect(a.rows[0].delta.prAuc).toBeCloseTo(-0.5, 12);
    const s = sensitivity({ q: 0.9, k: 2 }, (p) => ({ v: p.q * p.k }), [-0.5, 0.5]); expect(s.rows[0].ranges.v.min).toBeCloseTo(0.9, 12); expect(s.rows[1].ranges.v.max).toBeCloseTo(0.9 * 3, 12);
    const rr = regimeRobustness([{ regime: 'H', y: 1 }, { regime: 'L', y: 0 }], (list) => ({ recall: list[0].y })); expect(rr.worstRecall).toBe(0);
    const pf = (v, f) => Array.from({ length: 8 }, (_, i) => ({ prAuc: v + 0.001 * i, fpr: f })); const cc = championChallenger({ championPerFold: pf(0.1, 0.02), challengerPerFold: pf(0.3, 0.01), rng: new Rng(1) });
    expect(cc.verdict).toBe('CHALLENGER_BETTER_ADVISORY'); expect(cc.note).toMatch(/no automatic promotion/);
    expect(championChallenger({ championPerFold: pf(0.3, 0.01), challengerPerFold: pf(0.3, 0.01), rng: new Rng(1) }).verdict).toBe('CHAMPION_RETAINED');
  });
});

describe('golden cases', () => {
  it('TR-FUND-2026-001 is a blind SPECIFICATION: no outcome-derived keys; event facts are labelled as unverified secondary reports', () => {
    const spec = loadGoldenCase('TR-FUND-2026-001');
    expect(validateGoldenCaseSpec(spec)).toEqual([]); expect(spec.blind).toBe(true); expect(spec.status).toMatch(/NO_REAL_DATA/); expect(spec.event_time).toBeNull(); expect(spec.event_facts.provenance).toMatch(/NOT_VERIFIED/);
    expect(validateGoldenCaseSpec({ ...spec, blind: false })).toContain('case must declare blind:true'); expect(validateGoldenCaseSpec({ ...spec, learned_threshold: 3 })[0]).toMatch(/outcome-derived/);
  });
  it('without real data the golden case is BLOCKED_NO_DATA (never PASSED)', () => {
    const r = replayBlind({ spec: loadGoldenCase('TR-FUND-2026-001'), store: new PitStore(), evaluator: () => ({}) });
    expect(r.verdict).toBe(VERDICTS.BLOCKED_NO_DATA); expect(r.reason).toMatch(/EVENT_FACTS/); expect(replayMarketIntegrity().verdict).toBe(VERDICTS.BLOCKED_NO_DATA);
    expect(loadMarketIntegrityRegistry().cases).toEqual([]);
  });
  const world = generateWorld({ seed: 3, nFunds: 40, nAssets: 20, days: 400, nEvents: 2, fundsPerEvent: 2, firstEventDay: 250, lastEventDay: 330 });
  const ev = world.events[0]; const controls = world.funds.filter((f) => !f.event).map((f) => f.id);
  const spec = (over = {}) => ({ ...loadGoldenCase('TR-FUND-2026-001'), event_time: iso(ev.event_time), event_entities: ev.entities, evaluation: { pre_event_horizon_days: 60, evaluation_grid: 'weekly', gap_days: 1, false_alarm_budget_per_entity: 0.05, healthy_controls: { min_count: 20 }, min_required_coverage: 0.5, required_precursors: [{ field: 'close', entity_prefix: 'BIST:', min_observations: 30, lookback_days: 120 }, { field: 'holdings', entity_prefix: 'FUND:', min_observations: 2, lookback_days: 120 }] }, ...over });
  it('RELEASE_FAILURE: sufficient precursor data but no alarm before the event', () => {
    const r = replayBlind({ spec: spec(), store: world.store, evaluator: () => ({}), controlEntities: controls, dataKind: 'SYNTHETIC' });
    expect(r.verdict).toBe(VERDICTS.RELEASE_FAILURE); expect(r.coverage.fraction).toBe(1);
  });
  it('catching the event while alarming on every healthy control is a failure too (FALSE_ALARM_BUDGET_EXCEEDED)', () => {
    const r = replayBlind({ spec: spec(), store: world.store, evaluator: (view) => Object.fromEntries(view.entities('FUND:').map((e) => [e, true])), controlEntities: controls, dataKind: 'SYNTHETIC' });
    expect(r.verdict).toBe(VERDICTS.FALSE_ALARM_BUDGET_EXCEEDED); expect(r.eventCaught).toBe(ev.entities.length);
  });
  it('synthetic data can never produce PASSED; insufficient controls / coverage -> BLOCKED_NO_DATA', () => {
    const only = replayBlind({ spec: spec(), store: world.store, evaluator: (view) => Object.fromEntries(ev.entities.map((e) => [e, view.asOfMs > ev.event_time - 30 * DAY])), controlEntities: controls, dataKind: 'SYNTHETIC' });
    expect(only.verdict).toBe(VERDICTS.SYNTHETIC_HARNESS_PASS); expect(only.leads[0].leadDays).toBeGreaterThan(0);
    expect(replayBlind({ spec: spec(), store: world.store, evaluator: () => ({}), controlEntities: controls.slice(0, 5), dataKind: 'SYNTHETIC' }).reason).toBe('INSUFFICIENT_HEALTHY_CONTROLS');
    const cov = spec(); cov.evaluation.required_precursors = [{ field: 'free_float_shares', entity_prefix: 'BIST:', min_observations: 4, lookback_days: 365 }];
    expect(replayBlind({ spec: cov, store: world.store, evaluator: () => ({}), controlEntities: controls, dataKind: 'SYNTHETIC' }).reason).toBe('INSUFFICIENT_PRECURSOR_COVERAGE');
  });
  it('the replay never loads post-event information (evaluator views are as-of strictly before the event)', () => {
    const maxSeen = []; replayBlind({ spec: spec(), store: world.store, evaluator: (view) => { maxSeen.push(view.asOfMs); return {}; }, controlEntities: controls, dataKind: 'SYNTHETIC' });
    expect(Math.max(...maxSeen)).toBeLessThan(ev.event_time);
    expect(() => { const leaky = new PitStore(); leaky.add(obs({ t: T0 })); replayBlind({ spec: spec({ event_time: iso(T0 + 100 * DAY) }), store: leaky, evaluator: (view) => { if (view.asOfMs > T0 + 100 * DAY) throw new LookAheadError('x'); return {}; }, eventEntities: ['E'], controlEntities: [] }); }).not.toThrow(LookAheadError);
  });
});

describe('synthetic world & validation machinery', () => {
  it('REGRESSION: small asset universes no longer hang the generator (fragile pool smaller than k)', () => {
    const w = generateWorld({ seed: 1, nFunds: 10, nAssets: 12, days: 60, nEvents: 1, fundsPerEvent: 1, firstEventDay: 40, lastEventDay: 50, fragileHealthyShare: 1 });
    expect(w.store.size).toBeGreaterThan(0);
  });
  it('every synthetic observation is flagged SYNTHETIC, holdings are lagged, leverage can be UNOBSERVED (null)', () => {
    const w = generateWorld({ seed: 2, nFunds: 30, nAssets: 15, days: 80, nEvents: 1, fundsPerEvent: 1, firstEventDay: 60, lastEventDay: 70 });
    const v = w.store.asOf(w.startMs + 80 * DAY);
    expect(v.observations.every((o) => o.quality_flags.includes('SYNTHETIC'))).toBe(true);
    const early = w.store.asOf(w.startMs + 3 * DAY).latest(w.funds[0].id, 'holdings'); expect(early).toBeNull(); // reported on day 0, available only on day 7
    expect(w.store.asOf(w.startMs + 8 * DAY).latest(w.funds[0].id, 'holdings')).not.toBeNull();
    expect(v.observations.some((o) => o.field === 'debt_ratio' && o.value === null)).toBe(true);
  });
  it('fragility features: unobserved leverage stays null in the system; extractor never uses future data', () => {
    const w = generateWorld({ seed: 4, nFunds: 20, nAssets: 15, days: 120, nEvents: 1, fundsPerEvent: 1, firstEventDay: 100, lastEventDay: 110 });
    const view = w.store.asOf(w.startMs + 100 * DAY); const sys = systemFromView(view, w.assets.map((a) => a.id), w.funds.map((f) => f.id));
    expect(sys.funds.some((f) => f.debt === null)).toBe(true); expect(sys.funds.every((f) => f.marginRatio === null && f.beta === null)).toBe(true);
    // PROPERTY (look-ahead): features at T are identical whether or not the store also contains data from after T
    const T = w.startMs + 100 * DAY; const ids = [w.assets.map((a) => a.id), w.funds.map((f) => f.id)];
    const truncated = new PitStore(); for (const o of w.store.asOf(T).observations) truncated.add(o);
    // the 28-day-ago comparison view is also derived from `truncated`, which holds only data available at T
    const full = makeFeatureExtractor(w.store, ...ids).featuresAt(T); const trunc = makeFeatureExtractor(truncated, ...ids).featuresAt(T);
    expect(Object.keys(full).length).toBeGreaterThan(0); expect(JSON.stringify(trunc)).toBe(JSON.stringify(full));
  });
  it('end-to-end synthetic validation is deterministic and reports all required metrics + controls (small world)', () => {
    const opts = { seed: 7, worldOpts: { nFunds: 40, nAssets: 20, days: 460, nEvents: 4, fundsPerEvent: 2, firstEventDay: 320, lastEventDay: 440 } };
    const a = runSyntheticValidation(opts); const b = runSyntheticValidation(opts);
    expect(a.result_hash).toBe(b.result_hash); expect(a.kind).toBe('SYNTHETIC_VALIDATION'); expect(a.warning).toMatch(/ONLY/);
    for (const k of ['precision', 'recall', 'fpr', 'fnr', 'prAuc', 'brier', 'calibrationError', 'events', 'alarmStability', 'healthyFunds']) expect(a.summaries.B).toHaveProperty(k);
    expect(a.controls.B.labelPermutation).toHaveProperty('pValue'); expect(a.holdout.secondEvaluationRejected).toBe(true);
    expect(a.ablation.rows).toHaveLength(2); expect(a.championChallenger.note).toMatch(/advisory/); expect(a.design.regimeModel.calibration).toBe('ESTIMATED');
  }, 120000);
});
