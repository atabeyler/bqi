import { poissonSf, quantile, robustZ, median, betaInc } from '../../core/stats.js';
import { Rng } from '../../core/prng.js';
import { detectAnomalies } from '../anomaly/ensemble.js';
import { hypergeomSf, components } from '../coordination.js';
import { groupBy, hashKey, participantFills } from './events.js';

export const PARAMS = Object.freeze({
  alpha: 0.01,
  spoof: { cancelWithinMs: 1000, oppositeWithinMs: 5000, fillMax: 0.1, largeQuantile: 0.95, minRefLarge: 100, minGroupLarge: 3, minEpisodes: 2 },
  layer: { levels: 3, clusterGapMs: 2000, cancelWithinMs: 5000, oppositeWithinMs: 5000, fillMax: 0.1, minRefOrders: 200, minEpisodes: 2 },
  wash: { roundTripWindowMs: 60000, qtyTol: 0.1, minRoundTrips: 3 },
  close: { windowMs: 600000, minRefDays: 20, z: 3.5, minShareOfWindow: 0.05 },
  book: { z: 3.5, minOrders: 50, burstWindowMs: 1000, shortLifeMs: 100, minRefParticipants: 20, minRefDays: 30 },
  cross: { windowMs: 5000, permutations: 500, minEpisodes: 2, minRefLarge: 100 },
  coord: { binMs: 5000, minTrades: 5, maxParticipants: 150, minClusterSize: 3 },
});

export const MODELS = Object.freeze({
  spoofing: 'M70.spoofing', layering: 'M70.layering', wash: 'M70.wash_trading', close: 'M70.marking_close',
  book: 'M70.order_book_anomaly', cross: 'M70.cross_venue', coordination: 'M70.coordinated_trading',
});
const insufficient = (model, why, extra = {}) => ({ model, status: 'INSUFFICIENT_DATA', findings: [], stats: { reason: why, ...extra } });
const lowerBound = (arr, x) => { let lo = 0; let hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; };

/** sorted fill timestamps per participant|instrument|side */
function fillIndex(fills) {
  const m = groupBy(fills, (f) => `${f.participant}|${f.instrument}|${f.side}`);
  return new Map([...m.entries()].map(([k, v]) => [k, v.map((f) => f.ts).sort((a, b) => a - b)]));
}
const hasFillIn = (idx, participant, instrument, side, t0, t1) => { const a = idx.get(`${participant}|${instrument}|${side}`); if (!a) return false; const i = lowerBound(a, t0); return i < a.length && a[i] <= t1; };
const opposite = (s) => (s === 'B' ? 'S' : 'B');
const filledRatio = (o) => o.filled / o.qty;

/** Large-order threshold per instrument from the reference stream (quantile of order quantity). */
function largeThresholds(refOrders, q, minN = 30) {
  const g = groupBy(refOrders, (o) => o.instrument); const out = new Map();
  for (const [ins, os] of g) if (os.length >= minN) out.set(ins, quantile(os.map((o) => o.qty), q));
  return out;
}

function spoofEpisodes(orders, idx, thr, P) {
  const eps = []; let large = 0;
  for (const o of orders) {
    const t = thr.get(o.instrument); if (t === undefined || o.qty < t) continue;
    large++;
    if (o.cancelTs === null || o.cancelTs - o.ts > P.cancelWithinMs || filledRatio(o) > P.fillMax) continue;
    if (hasFillIn(idx, o.participant, o.instrument, opposite(o.side), o.ts, o.cancelTs + P.oppositeWithinMs)) eps.push(o);
  }
  return { eps, large };
}

/** D1 spoofing-like: large, quickly cancelled, unfilled orders followed by opposite-side execution; Poisson test against the reference rate. */
export function detectSpoofing(ref, ev, P, ctx) {
  const p = P.spoof; const refIdx = fillIndex(participantFills(ref.trades)); const thr = largeThresholds(ref.orders, p.largeQuantile);
  const r = spoofEpisodes(ref.orders, refIdx, thr, p);
  if (r.large < p.minRefLarge) return insufficient(MODELS.spoofing, `reference has ${r.large} large orders < ${p.minRefLarge}`);
  const r0 = Math.max(r.eps.length / r.large, 1 / (r.large + 1));
  const e = spoofEpisodes(ev.orders, fillIndex(participantFills(ev.trades)), thr, p);
  const groups = groupBy(ev.orders.filter((o) => { const t = thr.get(o.instrument); return t !== undefined && o.qty >= t; }), (o) => `${o.participant}|${o.instrument}`);
  const epsBy = groupBy(e.eps, (o) => `${o.participant}|${o.instrument}`);
  const eligible = [...groups.entries()].filter(([, v]) => v.length >= p.minGroupLarge); const m = Math.max(1, eligible.length);
  const findings = [];
  for (const [k, v] of eligible) {
    const eps = epsBy.get(k) || []; if (eps.length < p.minEpisodes) continue;
    const pv = poissonSf(eps.length, r0 * v.length);
    if (pv < P.alpha / m) findings.push({ participant: hashKey(ctx.salt, k.split('|')[0]), instrument: k.split('|')[1], largeOrders: v.length, episodes: eps.length, pValue: pv, bonferroniThreshold: P.alpha / m, firstEpisodeTs: eps[0].ts });
  }
  return { model: MODELS.spoofing, status: findings.length ? 'SIGNAL' : 'NO_SIGNAL', label: 'SPOOFING_LIKE_PATTERN', findings, stats: { referenceLargeOrders: r.large, referenceEpisodes: r.eps.length, referenceRate: r0, evalLargeOrders: e.large, evalEpisodes: e.eps.length, testedGroups: eligible.length, thresholds: Object.fromEntries(thr) } };
}

function layeringEpisodes(orders, idx, P) {
  const eps = []; const g = groupBy(orders, (o) => `${o.participant}|${o.instrument}|${o.side}`);
  for (const [k, os] of g) {
    const s = os.slice().sort((a, b) => a.ts - b.ts); let cl = [];
    const flush = () => {
      if (cl.length >= P.levels && new Set(cl.map((o) => o.price)).size >= P.levels) {
        const last = Math.max(...cl.map((o) => o.ts)); const allCancelled = cl.every((o) => o.cancelTs !== null && o.cancelTs - last <= P.cancelWithinMs && o.cancelTs >= o.ts);
        const fr = cl.reduce((a, o) => a + o.filled, 0) / cl.reduce((a, o) => a + o.qty, 0);
        if (allCancelled && fr <= P.fillMax) { const [pt, ins, side] = k.split('|'); const end = Math.max(...cl.map((o) => o.cancelTs)); if (hasFillIn(idx, pt, ins, opposite(side), cl[0].ts, end + P.oppositeWithinMs)) eps.push({ key: k, participant: pt, instrument: ins, side, orders: cl.length, levels: new Set(cl.map((o) => o.price)).size, startTs: cl[0].ts }); }
      }
      cl = [];
    };
    for (const o of s) { if (cl.length && o.ts - cl[cl.length - 1].ts > P.clusterGapMs) flush(); cl.push(o); }
    flush();
  }
  return eps;
}

/** D2 layering-like: stacks of same-side orders at distinct price levels, cancelled together, with opposite-side execution. */
export function detectLayering(ref, ev, P, ctx) {
  const p = P.layer;
  if (ref.orders.length < p.minRefOrders) return insufficient(MODELS.layering, `reference has ${ref.orders.length} orders < ${p.minRefOrders}`);
  const re = layeringEpisodes(ref.orders, fillIndex(participantFills(ref.trades)), p); const r0 = Math.max(re.length / ref.orders.length, 1 / (ref.orders.length + 1));
  const ee = layeringEpisodes(ev.orders, fillIndex(participantFills(ev.trades)), p);
  const nBy = groupBy(ev.orders, (o) => `${o.participant}|${o.instrument}`); const eBy = groupBy(ee, (x) => `${x.participant}|${x.instrument}`);
  const m = Math.max(1, nBy.size); const findings = [];
  for (const [k, eps] of eBy) { if (eps.length < p.minEpisodes) continue; const n = nBy.get(k).length; const pv = poissonSf(eps.length, r0 * n); if (pv < P.alpha / m) findings.push({ participant: hashKey(ctx.salt, k.split('|')[0]), instrument: k.split('|')[1], orders: n, episodes: eps.length, maxLevels: Math.max(...eps.map((x) => x.levels)), pValue: pv, bonferroniThreshold: P.alpha / m }); }
  return { model: MODELS.layering, status: findings.length ? 'SIGNAL' : 'NO_SIGNAL', label: 'LAYERING_LIKE_PATTERN', findings, stats: { referenceEpisodes: re.length, referenceRate: r0, evalEpisodes: ee.length, testedGroups: nBy.size } };
}

/** D3 self-match / round-trip (wash-like): rule based (UNCALIBRATED thresholds): same-owner crosses and offsetting round trips between a pair. */
export function detectWash(ev, P, ctx) {
  const p = P.wash; const ownerOf = (k) => ctx.ownerGroups?.[k] ?? k;
  const selfTrades = ev.trades.filter((t) => (t.buyerOwner && t.sellerOwner && t.buyerOwner === t.sellerOwner) || ownerOf(t.buyer) === ownerOf(t.seller));
  const byInstrVol = new Map(); for (const t of ev.trades) byInstrVol.set(t.instrument, (byInstrVol.get(t.instrument) || 0) + t.qty);
  const selfVol = new Map(); for (const t of selfTrades) selfVol.set(t.instrument, (selfVol.get(t.instrument) || 0) + t.qty);
  // round trips: A buys from B, later A sells to B (owner-collapsed), similar size
  const legs = ev.trades.filter((t) => ownerOf(t.buyer) !== ownerOf(t.seller)).map((t) => ({ a: ownerOf(t.buyer), b: ownerOf(t.seller), instrument: t.instrument, ts: t.ts, qty: t.qty }));
  const byPair = groupBy(legs, (l) => `${[l.a, l.b].sort().join('|')}|${l.instrument}`); const trips = [];
  for (const [k, ls] of byPair) {
    const s = ls.slice().sort((x, y) => x.ts - y.ts); const used = new Set();
    for (let i = 0; i < s.length; i++) {
      if (used.has(i)) continue;
      for (let j = i + 1; j < s.length; j++) {
        if (s[j].ts - s[i].ts > p.roundTripWindowMs) break;
        if (used.has(j)) continue;
        if (s[j].a === s[i].b && s[j].b === s[i].a && Math.abs(s[j].qty - s[i].qty) <= p.qtyTol * Math.max(s[i].qty, s[j].qty)) { used.add(i); used.add(j); trips.push({ pair: k, qty: Math.min(s[i].qty, s[j].qty), ts: s[i].ts }); break; }
      }
    }
  }
  const tripsBy = groupBy(trips, (t) => t.pair); const findings = [];
  for (const [k, ts] of tripsBy) if (ts.length >= p.minRoundTrips) { const [x, y, ins] = k.split('|'); findings.push({ kind: 'ROUND_TRIPS', participants: [hashKey(ctx.salt, x), hashKey(ctx.salt, y)].sort(), instrument: ins, roundTrips: ts.length, volume: ts.reduce((a, t) => a + t.qty * 2, 0) }); }
  if (selfTrades.length) for (const [ins, v] of selfVol) findings.push({ kind: 'SELF_MATCH', instrument: ins, trades: selfTrades.filter((t) => t.instrument === ins).length, volume: v, shareOfInstrumentVolume: byInstrVol.get(ins) > 0 ? v / byInstrVol.get(ins) : null });
  return { model: MODELS.wash, status: findings.length ? 'SIGNAL' : 'NO_SIGNAL', label: 'SELF_MATCH_OR_WASH_LIKE_PATTERN', findings, stats: { evalTrades: ev.trades.length, selfMatchTrades: selfTrades.length, roundTripPairs: tripsBy.size, rule: `>= ${p.minRoundTrips} round trips within ${p.roundTripWindowMs} ms, size tolerance ${p.qtyTol}`, ownerCollapsed: !!ctx.ownerGroups } };
}

/** D4 marking-the-close-like: participant's close-window volume fraction vs its own reference days; aligned with the window price move. */
export function detectMarkingClose(refDays, evDays, P, ctx) {
  const p = P.close; const findings = []; const unobserved = [];
  const frac = (day) => { // participant|instrument -> {fraction, windowVol, net, ret}
    const { trades, closeTs } = day; const out = new Map(); const byIns = groupBy(trades, (t) => t.instrument);
    for (const [ins, ts] of byIns) {
      const win = ts.filter((t) => t.ts >= closeTs - p.windowMs && t.ts <= closeTs); if (!win.length) continue;
      const sorted = ts.slice().sort((a, b) => a.ts - b.ts); const pre = sorted.filter((t) => t.ts < closeTs - p.windowMs); const winS = win.slice().sort((a, b) => a.ts - b.ts);
      const pxBefore = pre.length ? pre[pre.length - 1].price : null; const ret = pxBefore ? Math.log(winS[winS.length - 1].price / pxBefore) : null;
      const winVol = win.reduce((a, t) => a + t.qty, 0);
      for (const f of participantFills(ts)) {
        const k = `${f.participant}|${ins}`; const rec = out.get(k) || { day: 0, win: 0, net: 0, winVolMarket: winVol, ret };
        rec.day += f.qty; if (f.ts >= closeTs - p.windowMs && f.ts <= closeTs) { rec.win += f.qty; rec.net += f.side === 'B' ? f.qty : -f.qty; } out.set(k, rec);
      }
    }
    return out;
  };
  const refFr = new Map(); for (const d of refDays) for (const [k, r] of frac(d)) { if (r.day > 0) { if (!refFr.has(k)) refFr.set(k, []); refFr.get(k).push(r.win / r.day); } }
  let tested = 0;
  for (const d of evDays) {
    for (const [k, r] of frac(d)) {
      const base = refFr.get(k); if (!base || base.length < p.minRefDays) { unobserved.push(`close_reference:${k}`); continue; }
      tested++; const z = robustZ(r.win / r.day, base); if (!Number.isFinite(z)) continue;
      const aligned = r.ret !== null && r.net !== 0 && Math.sign(r.net) === Math.sign(r.ret);
      if (z > p.z && aligned && r.win / r.winVolMarket >= p.minShareOfWindow) findings.push({ participant: hashKey(ctx.salt, k.split('|')[0]), instrument: k.split('|')[1], day: d.day, closeWindowFraction: r.win / r.day, referenceMedianFraction: median(base), robustZ: z, windowReturn: r.ret, netDirection: Math.sign(r.net) });
    }
  }
  if (!tested) return { ...insufficient(MODELS.close, `no participant has >= ${p.minRefDays} reference days`), unobserved: [...new Set(unobserved)].slice(0, 50) };
  return { model: MODELS.close, status: findings.length ? 'SIGNAL' : 'NO_SIGNAL', label: 'CLOSE_CONCENTRATION_PATTERN', findings, stats: { tested, threshold: p.z, windowMs: p.windowMs }, unobserved: [...new Set(unobserved)].slice(0, 200) };
}

/** Exact binomial tails via the regularised incomplete beta: P(X>=k) and P(X<=k) for X~Bin(n,p). */
/** k and n may be non-integer (quasi-binomial effective counts). */
export const binomUpper = (k, n, p) => (k <= 0 ? 1 : k > n ? 0 : betaInc(p, k, n - k + 1));
export const binomLower = (k, n, p) => (k >= n ? 1 : k < 0 ? 0 : betaInc(1 - p, n - k, k + 1));

/**
 * D5 cancellation / message anomalies. Count based quasi-binomial (dispersion-adjusted) tests of each participant's cancel share, short-lifetime share and
 * order-to-trade ratio against the POOLED reference rate (small-sample ratios are never compared with other participants' ratios),
 * Bonferroni over participants x metrics; message bursts by Poisson tail; optional market-wide daily series through the anomaly ensemble.
 */
export function detectBookAnomalies(ref, ev, P, ctx) {
  const p = P.book;
  const feats = (orders, trades) => {
    const fills = groupBy(participantFills(trades), (f) => f.participant); const by = groupBy(orders, (o) => o.participant); const out = new Map();
    for (const [k, os] of by) { if (os.length < p.minOrders) continue; out.set(k, { n: os.length, fills: (fills.get(k) || []).length, cancelled: os.filter((o) => o.cancelTs !== null).length, short: os.filter((o) => o.cancelTs !== null && o.cancelTs - o.ts <= p.shortLifeMs).length }); }
    return out;
  };
  const rf = feats(ref.orders, ref.trades);
  if (rf.size < p.minRefParticipants) return insufficient(MODELS.book, `reference has ${rf.size} participants with >= ${p.minOrders} orders < ${p.minRefParticipants}`);
  const tot = [...rf.values()].reduce((a, x) => ({ n: a.n + x.n, fills: a.fills + x.fills, cancelled: a.cancelled + x.cancelled, short: a.short + x.short }), { n: 0, fills: 0, cancelled: 0, short: 0 });
  const clampP = (x) => Math.min(0.999, Math.max(1 / (tot.n + 1), x));
  const p0 = { cancel: clampP(tot.cancelled / tot.n), short: clampP(tot.short / tot.n), fill: clampP(tot.fills / tot.n) };
  // quasi-binomial dispersion from the reference participants (Pearson chi2/df, floored at 1): counts per participant are over-dispersed
  // relative to a pure binomial (e.g. fills include counterparty fills), and ignoring that would inflate the false-positive rate
  const disp = (key, pr) => { const rows = [...rf.values()]; const chi = rows.reduce((a, x) => a + (x[key] - x.n * pr) ** 2 / (x.n * pr * (1 - pr)), 0); return Math.max(1, chi / Math.max(1, rows.length - 1)); };
  const phi = { cancel: disp('cancelled', p0.cancel), short: disp('short', p0.short), fill: disp('fills', p0.fill) };
  const ef = feats(ev.orders, ev.trades); const findings = []; const m = Math.max(1, ef.size * 3);
  const up = (k, n, pr, f) => binomUpper(k / f, n / f, pr); const low = (k, n, pr, f) => binomLower(k / f, n / f, pr);
  for (const [k, f] of ef) {
    const tests = [['CANCELRATIO', up(f.cancelled, f.n, p0.cancel, phi.cancel), f.cancelled / f.n], ['SHORTLIFE', up(f.short, f.n, p0.short, phi.short), f.short / f.n], ['OTR', low(f.fills, f.n, p0.fill, phi.fill), f.n / Math.max(1, f.fills)]];
    for (const [kind, pv, value] of tests) if (pv < P.alpha / m) findings.push({ kind, participant: hashKey(ctx.salt, k), value, orders: f.n, pValue: pv, bonferroniThreshold: P.alpha / m });
  }
  // message bursts: max messages of a participant in any burstWindow vs pooled reference per-window rate
  const rate = (orders) => { const msgs = orders.length * 1; const t0 = Math.min(...orders.map((o) => o.ts)); const t1 = Math.max(...orders.map((o) => o.ts)); return msgs / Math.max(1, (t1 - t0) / p.burstWindowMs + 1); };
  const lam = Math.max(rate(ref.orders) / Math.max(1, groupBy(ref.orders, (o) => o.participant).size), 1e-6);
  const burst = []; const byP = groupBy(ev.orders, (o) => o.participant); const evTs = ev.orders.map((o) => o.ts); const nWin = Math.max(1, Math.ceil((Math.max(...evTs) - Math.min(...evTs) + 1) / p.burstWindowMs)); const mb = Math.max(1, byP.size * nWin); // Bonferroni over participants x windows
  for (const [k, os] of byP) { const ts = os.map((o) => o.ts).sort((a, b) => a - b); let best = 0; let j = 0; for (let i = 0; i < ts.length; i++) { while (ts[i] - ts[j] > p.burstWindowMs) j++; best = Math.max(best, i - j + 1); } const pv = poissonSf(best, lam); if (pv < P.alpha / mb) burst.push({ kind: 'MESSAGE_BURST', participant: hashKey(ctx.salt, k), maxMessagesInWindow: best, windowMs: p.burstWindowMs, expectedPerWindow: lam, pValue: pv, bonferroniThreshold: P.alpha / mb }); }
  findings.push(...burst);
  // market-wide daily cancel-ratio series through the existing anomaly ensemble (only with enough reference days)
  let ensemble = null;
  if (ctx.dailySeries?.reference?.length >= p.minRefDays) { const r = detectAnomalies({ reference: ctx.dailySeries.reference, evaluation: ctx.dailySeries.evaluation, seed: ctx.seed ?? 1 }); ensemble = { status: r.status, result_hash: r.result_hash }; }
  return { model: MODELS.book, status: findings.length ? 'SIGNAL' : 'NO_SIGNAL', label: 'ORDER_BOOK_MESSAGE_ANOMALY', findings, stats: { referenceParticipants: rf.size, evalParticipants: ef.size, pooledReferenceRates: p0, dispersion: phi, testedMetrics: m, burstRateReference: lam, marketCancelRatioEnsemble: ensemble } };
}

/** D6 cross-venue / cross-market: large quickly-cancelled orders on one instrument followed by opposite-side executions in a LINKED instrument; seeded permutation test. */
export function detectCrossVenue(ref, ev, P, ctx) {
  const p = P.cross; const links = ctx.instrumentLinks || [];
  if (!links.length) return insufficient(MODELS.cross, 'no instrumentLinks supplied (related instruments/venues must be declared)');
  const partner = new Map(); for (const [a, b] of links.map((l) => [l.a, l.b])) { if (!partner.has(a)) partner.set(a, new Set()); if (!partner.has(b)) partner.set(b, new Set()); partner.get(a).add(b); partner.get(b).add(a); }
  const thr = largeThresholds(ref.orders, P.spoof.largeQuantile);
  if (ref.orders.length < p.minRefLarge) return insufficient(MODELS.cross, `reference has ${ref.orders.length} orders < ${p.minRefLarge}`);
  const isSpoofy = (o) => { const t = thr.get(o.instrument); return t !== undefined && o.qty >= t && o.cancelTs !== null && o.cancelTs - o.ts <= P.spoof.cancelWithinMs && filledRatio(o) <= P.spoof.fillMax && partner.has(o.instrument); };
  const cand = ev.orders.filter(isSpoofy); const fills = participantFills(ev.trades);
  const times = ev.sorted.map((e) => e.ts); const t0 = Math.min(...times); const t1 = Math.max(...times);
  const count = (fillSet) => { const idx = fillIndex(fillSet); const per = new Map(); for (const o of cand) { for (const q of partner.get(o.instrument)) if (hasFillIn(idx, o.participant, q, opposite(o.side), o.ts, o.cancelTs + p.windowMs)) { per.set(o.participant, (per.get(o.participant) || 0) + 1); break; } } return per; };
  const obs = count(fills); const findings = []; const rng = new Rng(ctx.seed ?? 1).child('cross');
  const participants = [...obs.entries()].filter(([, k]) => k >= p.minEpisodes).sort((a, b) => a[0].localeCompare(b[0])); const m = Math.max(1, participants.length);
  for (const [pt, k] of participants) {
    const own = fills.filter((f) => f.participant === pt); let ge = 0;
    for (let b = 0; b < p.permutations; b++) {
      const shifted = own.map((f) => ({ ...f, ts: t0 + rng.next() * (t1 - t0) })); const idx = fillIndex(shifted);
      let c = 0; for (const o of cand) if (o.participant === pt) for (const q of partner.get(o.instrument)) if (hasFillIn(idx, pt, q, opposite(o.side), o.ts, o.cancelTs + p.windowMs)) { c++; break; }
      if (c >= k) ge++;
    }
    const pv = (1 + ge) / (p.permutations + 1);
    if (pv < P.alpha / m) findings.push({ participant: hashKey(ctx.salt, pt), episodes: k, pValue: pv, permutations: p.permutations, bonferroniThreshold: P.alpha / m });
  }
  return { model: MODELS.cross, status: findings.length ? 'SIGNAL' : 'NO_SIGNAL', label: 'CROSS_MARKET_LEAD_LAG_PATTERN', findings, stats: { candidateOrders: cand.length, participantsWithEpisodes: obs.size, linkedPairs: links.length, minAchievablePValue: 1 / (p.permutations + 1) } };
}

/** D7 coordinated trading: participants co-trading the same instrument/direction in the same time bins more than a hypergeometric null; Bonferroni; clusters >= 3. */
export function detectCoordinatedTrading(ev, P, ctx) {
  const p = P.coord; const fills = participantFills(ev.trades); if (!fills.length) return insufficient(MODELS.coordination, 'no trades');
  const t0 = Math.min(...fills.map((f) => f.ts)); const t1 = Math.max(...fills.map((f) => f.ts)); const nBins = Math.max(1, Math.ceil((t1 - t0 + 1) / p.binMs));
  const instruments = new Set(fills.map((f) => f.instrument)); const N = nBins * instruments.size * 2;
  const by = groupBy(fills, (f) => f.participant);
  const parts = [...by.entries()].filter(([, v]) => v.length >= p.minTrades).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).slice(0, p.maxParticipants);
  const sets = parts.map(([, v]) => new Set(v.map((f) => `${f.instrument}|${f.side}|${Math.floor((f.ts - t0) / p.binMs)}`)));
  const nPairs = (parts.length * (parts.length - 1)) / 2; const edges = [];
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
    let obs = 0; for (const k of sets[i]) if (sets[j].has(k)) obs++; if (obs < 2) continue;
    const pv = hypergeomSf(obs, N, sets[i].size, sets[j].size); if (pv * Math.max(1, nPairs) < P.alpha) edges.push([parts[i][0], parts[j][0], pv, obs]);
  }
  const clusters = components(parts.map((x) => x[0]), edges.map((e) => [e[0], e[1]])).filter((c) => c.length >= p.minClusterSize);
  const findings = clusters.map((c) => ({ size: c.length, participants: c.map((x) => hashKey(ctx.salt, x)).sort() }));
  return { model: MODELS.coordination, status: findings.length ? 'SIGNAL' : 'NO_SIGNAL', label: 'COORDINATED_TRADING_PATTERN', findings, stats: { participantsTested: parts.length, significantPairs: edges.length, bonferroniPairs: nPairs, population: N } };
}
