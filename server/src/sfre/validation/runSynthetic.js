import { generateWorld } from './syntheticWorld.js';
import { makeFeatureExtractor } from './fragilityAlarm.js';
import { classificationMetrics, prAuc, brier, ece, leadTimes, alarmStability, fitLogistic, thresholdForFpr } from './metrics.js';
import { makeFolds, LockedHoldout, HoldoutBurnedError, permutationControl, ablation, sensitivity, regimeRobustness, championChallenger } from './protocols.js';
import { regimeFilter } from '../engines/regime.js';
import { Rng } from '../core/prng.js';
import { quantile, logReturns, mean } from '../core/stats.js';
import { rateInterval } from '../engines/uncertainty.js';
import { hashOf } from '../core/canonical.js';

const DAY = 86400000;
export const HORIZON_DAYS = 45;

/** Rule definitions. Thresholds are FITTED on the training fold only. */
export const RULES = {
  A: { desc: 'fragility level >= theta (theta = (1-fprTarget) quantile of train negatives)', score: (s) => s.frag, fit: (train, p) => ({ theta: thresholdForFpr(train.map((s) => s.frag), train.map((s) => s.label), p.fprTarget) }), alarm: (s, m) => s.frag > m.theta },
  B: { desc: 'fragility CHANGE (28d) >= q-quantile of train negatives AND flow-anomaly signals >= flowMin', score: (s) => (s.dFrag === null || s.flowSig === null ? null : s.dFrag * s.flowSig), fit: (train, p) => ({ theta: quantile(train.filter((s) => !s.label && s.dFrag !== null).map((s) => s.dFrag), p.q) }), alarm: (s, m, p) => s.dFrag !== null && s.flowSig !== null && s.dFrag > m.theta && s.flowSig >= p.flowMin },
  'B-noFlow': { desc: 'ablation: B without the flow condition', score: (s) => s.dFrag, fit: (train, p) => ({ theta: quantile(train.filter((s) => !s.label && s.dFrag !== null).map((s) => s.dFrag), p.q) }), alarm: (s, m) => s.dFrag !== null && s.dFrag > m.theta },
  'B-noFrag': { desc: 'ablation: B without the fragility-change condition', score: (s) => s.flowSig, fit: () => ({}), alarm: (s, m, p) => s.flowSig !== null && s.flowSig >= p.flowMin },
};
export const DEFAULT_PARAMS = { fprTarget: 0.01, q: 0.95, flowMin: 1 };

function buildSamples(world, extractor, times) {
  const byT = new Map();
  const eventOf = new Map(); world.events.forEach((ev) => ev.entities.forEach((e) => eventOf.set(e, ev)));
  for (const T of times) {
    const feats = extractor.featuresAt(T);
    const rows = [];
    for (const [fund, f] of Object.entries(feats)) {
      const ev = eventOf.get(fund);
      if (ev && T >= ev.event_time) continue; // post-event samples are not part of the pre-event task
      const label = !!ev && T >= ev.event_time - HORIZON_DAYS * DAY && T < ev.event_time;
      rows.push({ fund, t: T, label, ...f });
    }
    byT.set(T, rows);
  }
  return byT;
}

function evalRule(rule, params, samplesByT, times, folds) {
  const R = RULES[rule]; const out = [];
  folds.forEach((f, fi) => {
    const train = f.trainIdx.flatMap((i) => samplesByT.get(times[i])).filter((s) => R.score(s) !== null || rule === 'A');
    const model = R.fit(train, params);
    const trScores = train.map((s) => R.score(s)).filter((v) => v !== null); const trLabels = train.filter((s) => R.score(s) !== null).map((s) => s.label);
    const logi = trScores.length > 20 && trLabels.some(Boolean) ? fitLogistic(trScores, trLabels) : null;
    for (const i of f.testIdx) for (const s of samplesByT.get(times[i])) {
      const sc = R.score(s);
      out.push({ fold: fi, fund: s.fund, t: s.t, label: s.label, score: sc ?? 0, alarm: sc === null ? false : !!R.alarm(s, model, params), prob: logi && sc !== null ? logi.predict(sc) : null, observed: sc !== null });
    }
  });
  return out;
}

export function summarize(preds, world) {
  const labels = preds.map((p) => p.label);
  const cm = classificationMetrics(labels, preds.map((p) => p.alarm));
  const probs = preds.filter((p) => p.prob !== null);
  const alarmsByEntity = {};
  for (const p of preds) (alarmsByEntity[p.fund] ||= []).push({ t: p.t, alarm: p.alarm });
  const events = world.events.flatMap((ev) => ev.entities.map((e) => ({ entity: e, event_time: ev.event_time })));
  const testedEvents = events.filter((e) => (alarmsByEntity[e.entity] || []).some((x) => x.t >= e.event_time - HORIZON_DAYS * DAY));
  const leads = leadTimes(testedEvents, alarmsByEntity, HORIZON_DAYS * DAY);
  const healthy = Object.keys(alarmsByEntity).filter((e) => !events.some((x) => x.entity === e));
  const healthyAlarmed = healthy.filter((e) => alarmsByEntity[e].some((x) => x.alarm)).length;
  const caught = leads.filter((l) => l.leadMs !== null);
  const leadDays = caught.map((l) => l.leadMs / DAY).sort((a, b) => a - b);
  return {
    samples: preds.length, positives: cm.positives, negatives: cm.negatives, baseRate: cm.baseRate,
    confusion: { tp: cm.tp, fp: cm.fp, tn: cm.tn, fn: cm.fn },
    precision: cm.precision, recall: cm.recall, fpr: cm.fpr, fnr: cm.fnr,
    prAuc: prAuc(labels, preds.map((p) => p.score)),
    brier: probs.length ? brier(probs.map((p) => p.prob), probs.map((p) => p.label)) : null,
    calibrationError: probs.length ? ece(probs.map((p) => p.prob), probs.map((p) => p.label)) : null,
    events: { tested: testedEvents.length, caughtBeforeEvent: caught.length, eventRecall: rateInterval(caught.length, testedEvents.length), leadDaysMedian: leadDays.length ? quantile(leadDays, 0.5) : null, leadDaysIQR: leadDays.length ? [quantile(leadDays, 0.25), quantile(leadDays, 0.75)] : null },
    healthyFunds: { n: healthy.length, withAtLeastOneAlarm: healthyAlarmed, perFundFalseAlarmRate: rateInterval(healthyAlarmed, healthy.length) },
    alarmStability: alarmStability(alarmsByEntity),
  };
}

const flat = (s) => ({ prAuc: s.prAuc, precision: s.precision.point ?? 0, recall: s.recall.point ?? 0, fpr: s.fpr.point ?? 0 });

/** Full synthetic validation run (machinery check; SYNTHETIC data; no real-world claim). */
export function runSyntheticValidation({ seed = 1, worldOpts = {}, verbose = false } = {}) {
  const t0 = Date.now();
  const world = generateWorld({ seed, ...worldOpts });
  const assetIds = world.assets.map((a) => a.id); const fundIds = world.funds.map((f) => f.id);
  const firstDay = 252;
  const times = []; for (let d = firstDay; d <= world.days; d += 7) times.push(world.startMs + d * DAY);
  const extractor = makeFeatureExtractor(world.store, assetIds, fundIds);
  const samplesByT = buildSamples(world, extractor, times);
  if (verbose) console.log(`features built ${Date.now() - t0}ms`);
  const nDev = Math.floor(times.length * 0.8); const purge = Math.ceil(HORIZON_DAYS / 7);
  const folds = makeFolds({ n: nDev, initialTrain: 12, testSize: 6, purge, mode: 'expanding' });
  const rng = new Rng(seed + 1000);

  const preds = {}; const summaries = {};
  for (const r of Object.keys(RULES)) { preds[r] = evalRule(r, DEFAULT_PARAMS, samplesByT, times, folds); summaries[r] = summarize(preds[r], world); }

  // negative controls on the champion & challenger
  const controls = {};
  for (const r of ['A', 'B']) {
    const labels = preds[r].map((p) => p.label); const scores = preds[r].map((p) => p.score);
    const perm = permutationControl({ labels, scores, rng: rng.child(`perm-${r}`), B: 200 });
    // time-shuffle: permute each fund's score vector over time (destroys temporal precursor structure, keeps level)
    const byFund = new Map(); preds[r].forEach((p, i) => { if (!byFund.has(p.fund)) byFund.set(p.fund, []); byFund.get(p.fund).push(i); });
    const shuffled = scores.slice(); const rr = rng.child(`ts-${r}`);
    for (const idx of byFund.values()) { const vals = rr.shuffle(idx.map((i) => scores[i])); idx.forEach((i, k) => { shuffled[i] = vals[k]; }); }
    controls[r] = { labelPermutation: perm, timeShuffledPrAuc: prAuc(labels, shuffled), observedPrAuc: perm.observedPrAuc, baseRate: perm.baseRate };
  }

  // ablation (on B)
  const ablRules = { B: 'B', flow: 'B-noFlow', frag: 'B-noFrag' };
  const abl = ablation(['flow', 'frag'], (disabled) => { const r = disabled.has('flow') ? 'B-noFlow' : disabled.has('frag') ? 'B-noFrag' : 'B'; return flat(summarize(evalRule(r, DEFAULT_PARAMS, samplesByT, times, folds), world)); });
  void ablRules;

  // sensitivity of rule B parameters
  const sens = sensitivity({ q: DEFAULT_PARAMS.q, flowMin: DEFAULT_PARAMS.flowMin, fprTarget: DEFAULT_PARAMS.fprTarget }, (p) => flat(summarize(evalRule('B', { ...p, q: Math.min(0.999, Math.max(0.5, p.q)) }, samplesByT, times, folds), world)), [-0.5, -0.2, 0.2, 0.5]);

  // regime robustness (HMM filtered state on mean asset return, trained on the first 251 days only)
  const meanRet = []; { const series = assetIds.map((id) => world.store.asOf(world.startMs + world.days * DAY + 8 * DAY).series(id, 'close').map((x) => x.value)); const rets = series.map((s) => logReturns(s)); for (let d = 0; d < rets[0].length; d++) meanRet.push(mean(rets.map((r) => r[d]))); }
  const reg = regimeFilter({ train: meanRet.slice(0, firstDay - 1), evaluate: meanRet.slice(firstDay - 1) });
  const regimeByT = (T) => { const day = Math.round((T - world.startMs) / DAY); const p = reg.value?.filteredHighVolProb?.[day - firstDay]; return p === undefined ? 'UNKNOWN' : p > 0.5 ? 'HIGH_VOL' : 'LOW_VOL'; };
  const regimeSamples = preds.B.map((p) => ({ ...p, regime: regimeByT(p.t) }));
  const regimeRob = regimeRobustness(regimeSamples, (list) => { const s = summarize(list, world); return { recall: s.recall.point, fpr: s.fpr.point, positives: s.positives, negatives: s.negatives, prAuc: s.prAuc }; });

  // champion / challenger on identical folds
  const perFold = (rule) => folds.map((_, fi) => { const s = summarize(preds[rule].filter((p) => p.fold === fi), world); return flat(s); });
  const cc = championChallenger({ championPerFold: perFold('A'), challengerPerFold: perFold('B'), rng: rng.child('cc') });

  // locked holdout: thresholds fitted on all development data, evaluated exactly once
  const holdoutTimes = times.slice(nDev);
  const devTrainIdx = Array.from({ length: nDev - purge }, (_, i) => i);
  const holdoutFold = [{ trainIdx: devTrainIdx, testIdx: holdoutTimes.map((_, i) => nDev + i) }];
  const hold = new LockedHoldout({ ids: holdoutTimes.map(String), periodStart: holdoutTimes[0], periodEnd: holdoutTimes[holdoutTimes.length - 1] });
  const holdoutResult = hold.evaluate(() => ({ A: summarize(evalRule('A', DEFAULT_PARAMS, samplesByT, times, holdoutFold), world), B: summarize(evalRule('B', DEFAULT_PARAMS, samplesByT, times, holdoutFold), world) }));
  let burned = false; try { hold.evaluate(() => 1); } catch (e) { burned = e instanceof HoldoutBurnedError; }

  const resultCore = { summaries, controls, ablation: abl, sensitivity: sens, regimeRobustness: regimeRob, championChallenger: cc, holdout: { lock_hash: holdoutResult.lock_hash, ...holdoutResult.result, secondEvaluationRejected: burned } };
  return {
    kind: 'SYNTHETIC_VALIDATION', warning: 'Synthetic data generated by the same author as the detectors: validates machinery and internal consistency ONLY. Not evidence of real-world predictive power. No model status changes.',
    seed, world: { params: world.params, events: world.events.map((e) => ({ id: e.id, day: e.day, funds: e.entities.length })), healthyFragileFunds: world.funds.filter((f) => f.fragileHealthy).length, observations: world.store.size },
    design: { horizonDays: HORIZON_DAYS, evaluationDates: times.length, developmentDates: nDev, holdoutDates: holdoutTimes.length, folds: folds.length, purgeDates: purge, params: DEFAULT_PARAMS, rules: Object.fromEntries(Object.entries(RULES).map(([k, v]) => [k, v.desc])), regimeModel: { status: reg.status, calibration: reg.calibration } },
    ...resultCore, elapsedMs: Date.now() - t0, result_hash: hashOf(JSON.parse(JSON.stringify(resultCore))),
  };
}
