import { median, robustScale, finite, mean } from '../../core/stats.js';

/** Each detector: {model, status: SIGNAL|NO_SIGNAL|INSUFFICIENT_DATA, score, threshold, flagged:[idx], detail}.
 *  Reference points must precede evaluation points in time (caller's responsibility; the firewall enforces it upstream). */

export const PARAMS = Object.freeze({
  robustZ: { threshold: 3.5, source: 'Iglewicz-Hoaglin 1993', minRef: 30 },
  ewma: { lambda: 0.2, L: 3, source: 'SPC textbook', minRef: 30 },
  cusum: { k: 0.5, h: 5, source: 'SPC textbook', minRef: 30 },
  changePoint: { penalty: 'BIC: 2*ln(n)', minRef: 30, maxDepth: 3 },
  isolationForest: { trees: 100, subsample: 256, alpha: 0.01, threshold: 'split-conformal quantile of calibration scores', source: 'Liu et al. 2008; conformal threshold', minRef: 60, trainFraction: 0.6 },
  lof: { k: 20, alpha: 0.01, threshold: 'split-conformal quantile of calibration scores', source: 'Breunig et al. 2000; conformal threshold', minRef: 60, trainFraction: 0.6 },
});

const insufficient = (model, why) => ({ model, status: 'INSUFFICIENT_DATA', score: null, threshold: null, flagged: [], detail: why });
const clean = (a) => a.filter(finite);

export function robustZDetector(reference, evaluation) {
  const p = PARAMS.robustZ; const ref = clean(reference);
  if (ref.length < p.minRef) return insufficient('robust_z', `reference n=${ref.length} < ${p.minRef}`);
  const s = robustScale(ref); if (!(s > 0)) return insufficient('robust_z', 'reference has zero spread');
  const m = median(ref);
  const z = evaluation.map((x) => (finite(x) ? (x - m) / s : null));
  const flagged = z.map((v, i) => (v !== null && Math.abs(v) > p.threshold ? i : -1)).filter((i) => i >= 0);
  const mx = Math.max(...z.filter((v) => v !== null).map(Math.abs), 0);
  return { model: 'robust_z', status: flagged.length ? 'SIGNAL' : 'NO_SIGNAL', score: mx, threshold: p.threshold, flagged, detail: { z } };
}

export function ewmaDetector(reference, evaluation) {
  const p = PARAMS.ewma; const ref = clean(reference);
  if (ref.length < p.minRef) return insufficient('ewma', `reference n=${ref.length} < ${p.minRef}`);
  const s = robustScale(ref); if (!(s > 0)) return insufficient('ewma', 'reference has zero spread');
  const m = median(ref); const limit = p.L * Math.sqrt(p.lambda / (2 - p.lambda));
  let e = 0; const path = []; const flagged = [];
  evaluation.forEach((x, i) => { if (!finite(x)) { path.push(null); return; } e = p.lambda * ((x - m) / s) + (1 - p.lambda) * e; path.push(e); if (Math.abs(e) > limit) flagged.push(i); });
  const mx = Math.max(...path.filter((v) => v !== null).map(Math.abs), 0);
  return { model: 'ewma', status: flagged.length ? 'SIGNAL' : 'NO_SIGNAL', score: mx, threshold: limit, flagged, detail: { path } };
}

export function cusumDetector(reference, evaluation) {
  const p = PARAMS.cusum; const ref = clean(reference);
  if (ref.length < p.minRef) return insufficient('cusum', `reference n=${ref.length} < ${p.minRef}`);
  const s = robustScale(ref); if (!(s > 0)) return insufficient('cusum', 'reference has zero spread');
  const m = median(ref); let hi = 0; let lo = 0; let mx = 0; const flagged = [];
  evaluation.forEach((x, i) => { if (!finite(x)) return; const z = (x - m) / s; hi = Math.max(0, hi + z - p.k); lo = Math.max(0, lo - z - p.k); mx = Math.max(mx, hi, lo); if (hi > p.h || lo > p.h) flagged.push(i); });
  return { model: 'cusum', status: flagged.length ? 'SIGNAL' : 'NO_SIGNAL', score: mx, threshold: p.h, flagged, detail: {} };
}

function bestSplit(x, sigma2, lo, hi) {
  // maximize (n1 n2 / n) (m1 - m2)^2 / sigma2 over split in (lo, hi)
  const n = hi - lo; let pre = 0; const total = x.slice(lo, hi).reduce((a, b) => a + b, 0);
  let best = { stat: 0, tau: -1 };
  for (let i = lo; i < hi - 1; i++) {
    pre += x[i]; const n1 = i - lo + 1; const n2 = n - n1;
    if (n1 < 5 || n2 < 2) continue;
    const m1 = pre / n1; const m2 = (total - pre) / n2;
    const stat = (n1 * n2 / n) * (m1 - m2) ** 2 / sigma2;
    if (stat > best.stat) best = { stat, tau: i + 1 };
  }
  return best;
}

export function changePointDetector(reference, evaluation) {
  const p = PARAMS.changePoint; const ref = clean(reference);
  if (ref.length < p.minRef) return insufficient('change_point', `reference n=${ref.length} < ${p.minRef}`);
  const s = robustScale(ref); if (!(s > 0)) return insufficient('change_point', 'reference has zero spread');
  const ev = evaluation.filter(finite);
  if (ev.length < 2) return insufficient('change_point', 'evaluation window too short');
  const x = [...ref, ...ev]; const n = x.length; const pen = 2 * Math.log(n);
  const cps = [];
  const rec = (lo, hi, depth) => {
    if (depth > p.maxDepth || hi - lo < 8) return;
    const b = bestSplit(x, s * s, lo, hi);
    if (b.tau > 0 && b.stat > pen) { cps.push({ index: b.tau, stat: b.stat }); rec(lo, b.tau, depth + 1); rec(b.tau, hi, depth + 1); }
  };
  rec(0, n, 1);
  const inEval = cps.filter((c) => c.index >= ref.length - 1);
  return { model: 'change_point', status: inEval.length ? 'SIGNAL' : 'NO_SIGNAL', score: Math.max(0, ...cps.map((c) => c.stat)), threshold: pen, flagged: inEval.map((c) => c.index - ref.length), detail: { changePoints: cps } };
}

const EULER = 0.5772156649;
const cFactor = (n) => (n <= 1 ? 0 : n === 2 ? 1 : 2 * (Math.log(n - 1) + EULER) - 2 * (n - 1) / n);

function buildTree(data, idx, depth, maxDepth, rng) {
  if (depth >= maxDepth || idx.length <= 1) return { size: idx.length };
  const dim = rng.int(data[0].length);
  let lo = Infinity; let hi = -Infinity;
  for (const i of idx) { const v = data[i][dim]; if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!(hi > lo)) return { size: idx.length };
  const split = lo + rng.next() * (hi - lo);
  const L = idx.filter((i) => data[i][dim] < split); const R = idx.filter((i) => data[i][dim] >= split);
  return { dim, split, left: buildTree(data, L, depth + 1, maxDepth, rng), right: buildTree(data, R, depth + 1, maxDepth, rng) };
}
const pathLen = (x, node, depth = 0) => (node.left ? pathLen(x, x[node.dim] < node.split ? node.left : node.right, depth + 1) : depth + cFactor(node.size));

function standardize(ref, pts) {
  const D = ref[0].length; const med = []; const sc = [];
  for (let d = 0; d < D; d++) { const col = ref.map((r) => r[d]); med.push(median(col)); const s = robustScale(col); sc.push(s > 0 ? s : 1); }
  return { ref: ref.map((r) => r.map((v, d) => (v - med[d]) / sc[d])), pts: pts.map((r) => r.map((v, d) => (v - med[d]) / sc[d])) };
}

/** Embed a scalar series as 2-D points (x_t, x_t - x_{t-1}); features may be supplied instead. */
export function embed(series, prev) {
  const out = []; let last = prev;
  for (const x of series) { out.push([x, finite(last) && finite(x) ? x - last : 0]); last = x; }
  return out;
}

/** split-conformal threshold: ceil((n+1)(1-alpha))-th smallest calibration score (max if n too small to resolve alpha). */
export function conformalThreshold(calScores, alpha) {
  const sorted = calScores.slice().sort((a, b) => a - b);
  const k = Math.ceil((sorted.length + 1) * (1 - alpha));
  return { value: sorted[Math.min(sorted.length, k) - 1], resolvable: k <= sorted.length };
}

function forestScores(trainPts, pts, rng) {
  const p = PARAMS.isolationForest;
  const psi = Math.min(p.subsample, trainPts.length); const maxDepth = Math.ceil(Math.log2(psi));
  const trees = [];
  for (let t = 0; t < p.trees; t++) trees.push(buildTree(trainPts, rng.shuffle(trainPts.map((_, i) => i)).slice(0, psi), 0, maxDepth, rng));
  const cpsi = cFactor(psi);
  return pts.map((x) => (x.every(finite) ? 2 ** (-(mean(trees.map((tr) => pathLen(x, tr))) / cpsi)) : null));
}

export function isolationForestDetector(refPts, evalPts, rng) {
  const p = PARAMS.isolationForest;
  const ref = refPts.filter((r) => r.every(finite));
  if (ref.length < p.minRef) return insufficient('isolation_forest', `reference n=${ref.length} < ${p.minRef}`);
  const nTrain = Math.floor(ref.length * p.trainFraction);
  const train = ref.slice(0, nTrain); const cal = ref.slice(nTrain); // time-ordered split
  const calScores = forestScores(train, cal, rng.child('cal')).filter((v) => v !== null);
  const thr = conformalThreshold(calScores, p.alpha);
  const scores = forestScores(train, evalPts, rng.child('eval'));
  const flagged = scores.map((sc, i) => (sc !== null && sc > thr.value ? i : -1)).filter((i) => i >= 0);
  return { model: 'isolation_forest', status: flagged.length ? 'SIGNAL' : 'NO_SIGNAL', score: Math.max(0, ...scores.filter((v) => v !== null)), threshold: thr.value, flagged, detail: { scores, thresholdResolvable: thr.resolvable, nTrain, nCal: cal.length } };
}

function lofScores(refRaw, ptsRaw, evalOk) {
  const p = PARAMS.lof;
  const { ref, pts } = standardize(refRaw, ptsRaw);
  const k = Math.min(p.k, ref.length - 1); const n = ref.length;
  const dist = (a, b) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0));
  const D = ref.map((a) => ref.map((b) => dist(a, b)));
  const nbr = []; const kd = [];
  for (let i = 0; i < n; i++) { const order = D[i].map((d, j) => [d, j]).filter(([, j]) => j !== i).sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, k); nbr.push(order.map((o) => o[1])); kd.push(order[order.length - 1][0]); }
  const lrdRef = nbr.map((ns, i) => { const rd = ns.reduce((s, j) => s + Math.max(kd[j], D[i][j]), 0) / k; return rd > 0 ? 1 / rd : Infinity; });
  return pts.map((x, qi) => {
    if (!evalOk[qi]) return null;
    const d = ref.map((r) => dist(x, r)); const order = d.map((v, j) => [v, j]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, k);
    const rd = order.reduce((s, [v, j]) => s + Math.max(kd[j], v), 0) / k;
    const lrd = rd > 0 ? 1 / rd : Infinity;
    const num = order.reduce((s, [, j]) => s + lrdRef[j], 0) / k;
    return Number.isFinite(lrd) && Number.isFinite(num) ? num / lrd : 1;
  });
}

export function lofDetector(refPts, evalPts) {
  const p = PARAMS.lof;
  const ref = refPts.filter((r) => r.every(finite));
  if (ref.length < p.minRef) return insufficient('lof', `reference n=${ref.length} < ${p.minRef}`);
  const nTrain = Math.floor(ref.length * p.trainFraction);
  const train = ref.slice(0, nTrain); const cal = ref.slice(nTrain);
  const calScores = lofScores(train, cal, cal.map(() => true)).filter((v) => v !== null);
  const thr = conformalThreshold(calScores, p.alpha);
  const ok = evalPts.map((r) => r.every(finite));
  const scores = lofScores(train, evalPts.map((r, i) => (ok[i] ? r : train[0])), ok);
  const flagged = scores.map((sc, i) => (sc !== null && sc > thr.value ? i : -1)).filter((i) => i >= 0);
  return { model: 'lof', status: flagged.length ? 'SIGNAL' : 'NO_SIGNAL', score: Math.max(0, ...scores.filter((v) => v !== null)), threshold: thr.value, flagged, detail: { scores, thresholdResolvable: thr.resolvable, nTrain, nCal: cal.length } };
}
