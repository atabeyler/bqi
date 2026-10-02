import { makeResult, STATUS, CALIBRATION, coverageOf, failed } from '../core/result.js';
import { poissonSf, lgamma } from '../core/stats.js';
import { sha256 } from '../core/canonical.js';

const ENGINE = 'coordination';
export const FORBIDDEN_FIELDS = Object.freeze(['name', 'real_name', 'email', 'phone', 'tckn', 'national_id', 'handle', 'username', 'ip', 'address']);
export const PARAMS = Object.freeze({ alpha: 0.01, binMs: 3600000, deltaMs: 300000, minPostsPerAuthor: 3, nearDupJaccard: 0.8, shingle: 5, maxAuthors: 150, maxPosts: 1500, minRefBins: 24 });
const DISCLAIMER = 'Pattern consistent with coordination; does not establish intent, identity, or wrongdoing.';

function shingles(text, k = PARAMS.shingle) { const t = String(text || '').toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ').trim(); const set = new Set(); for (let i = 0; i + k <= t.length; i++) set.add(t.slice(i, i + k)); return set; }
function jaccard(a, b) { if (!a.size || !b.size) return 0; let inter = 0; const [s, l] = a.size < b.size ? [a, b] : [b, a]; for (const x of s) if (l.has(x)) inter++; return inter / (a.size + b.size - inter); }

const lchoose = (n, k) => lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);
/** P(X >= x) for X ~ Hypergeometric(N population, K successes, n draws) */
export function hypergeomSf(x, N, K, n) {
  let p = 0;
  for (let k = x; k <= Math.min(K, n); k++) { if (n - k > N - K) continue; p += Math.exp(lchoose(K, k) + lchoose(N - K, n - k) - lchoose(N, n)); }
  return Math.min(1, p);
}

export function components(nodes, edges) {
  const parent = new Map(nodes.map((n) => [n, n]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const [a, b] of edges) parent.set(find(a), find(b));
  const groups = new Map();
  for (const n of nodes) { const r = find(n); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(n); }
  return [...groups.values()].filter((g) => g.length >= 3);
}

/**
 * posts: [{author_key (pseudonymous), time (ms), text}] already split by the caller into reference (before) and eval.
 * Identity fields are rejected. Outputs hashed author keys at cluster level only.
 */
export function detectCoordination({ referencePosts, evalPosts, salt = 'sfre', params = {} }) {
  const P = { ...PARAMS, ...params };
  for (const p of [...referencePosts, ...evalPosts]) for (const f of FORBIDDEN_FIELDS) if (f in p) return failed(ENGINE, 'M52.coordination', `identity field "${f}" rejected: SFRE does not profile individuals`, { parameters: P });
  if (evalPosts.length > P.maxPosts) return makeResult({ engine: ENGINE, modelId: 'M52.coordination', status: STATUS.MODEL_UNCERTAIN, parameters: P, notes: [`${evalPosts.length} posts exceeds maxPosts ${P.maxPosts}; sample upstream`] });
  const refMax = referencePosts.length ? Math.max(...referencePosts.map((p) => p.time)) : -Infinity;
  const evMin = evalPosts.length ? Math.min(...evalPosts.map((p) => p.time)) : Infinity;
  if (refMax >= evMin) return failed(ENGINE, 'M52.coordination', 'reference posts must strictly precede evaluation posts (look-ahead guard)', { parameters: P });
  const t0 = referencePosts.length ? Math.min(...referencePosts.map((p) => p.time)) : null;
  const refBins = t0 === null ? 0 : Math.floor((refMax - t0) / P.binMs) + 1;
  if (refBins < P.minRefBins || !evalPosts.length) return makeResult({ engine: ENGINE, modelId: 'M52.coordination', status: STATUS.INSUFFICIENT_DATA, coverage: coverageOf(refBins, P.minRefBins), parameters: P });

  // 1) burst detection vs reference Poisson rate (Bonferroni over eval bins)
  const rate = Math.max(referencePosts.length / refBins, 1 / (refBins + 1)); // floor keeps the null rate strictly positive
  const evT0 = evMin; const counts = new Map();
  for (const p of evalPosts) { const b = Math.floor((p.time - evT0) / P.binMs); counts.set(b, (counts.get(b) || 0) + 1); }
  const nBins = Math.floor((Math.max(...evalPosts.map((p) => p.time)) - evT0) / P.binMs) + 1;
  const bursts = [...counts.entries()].map(([b, c]) => ({ bin: b, count: c, p: poissonSf(c, rate) })).filter((x) => x.p < P.alpha / nBins);

  // 2) temporal co-activity: pairs of authors sharing delta-bins more than a permutation null
  const byAuthor = new Map();
  for (const p of evalPosts) { if (!byAuthor.has(p.author_key)) byAuthor.set(p.author_key, []); byAuthor.get(p.author_key).push(p.time); }
  let authors = [...byAuthor.entries()].filter(([, ts]) => ts.length >= P.minPostsPerAuthor).sort((a, b) => b[1].length - a[1].length || String(a[0]).localeCompare(String(b[0]))).slice(0, P.maxAuthors);
  const span = Math.max(...evalPosts.map((p) => p.time)) - evT0 + 1; const dBins = Math.max(1, Math.ceil(span / P.deltaMs));
  const binSet = (ts) => new Set(ts.map((t) => Math.floor((t - evT0) / P.deltaMs)));
  const sets = authors.map(([, ts]) => binSet(ts));
  const nPairs = (authors.length * (authors.length - 1)) / 2;
  const edges = [];
  for (let i = 0; i < authors.length; i++) for (let j = i + 1; j < authors.length; j++) {
    let obs = 0; for (const b of sets[i]) if (sets[j].has(b)) obs++;
    if (obs < 2) continue;
    // exact null: shared bins ~ Hypergeometric(N=dBins, K=|A_i|, n=|A_j|) if both authors post at uniformly random times
    const pv = hypergeomSf(obs, dBins, sets[i].size, sets[j].size);
    if (pv * Math.max(1, nPairs) < P.alpha) edges.push([authors[i][0], authors[j][0], pv]); // Bonferroni over all author pairs
  }
  const coClusters = components(authors.map((a) => a[0]), edges.map((e) => [e[0], e[1]]));

  // 3) semantic near-duplicates across different authors
  const sh = evalPosts.map((p) => shingles(p.text));
  const dupEdges = [];
  for (let i = 0; i < evalPosts.length; i++) for (let j = i + 1; j < evalPosts.length; j++) {
    if (evalPosts[i].author_key === evalPosts[j].author_key) continue;
    if (jaccard(sh[i], sh[j]) >= P.nearDupJaccard) dupEdges.push([evalPosts[i].author_key, evalPosts[j].author_key]);
  }
  const dupNodes = [...new Set(dupEdges.flat())];
  const dupClusters = components(dupNodes, dupEdges);

  const hash = (k) => sha256(`${salt}|${k}`).slice(0, 12);
  const clusters = [
    ...coClusters.map((c) => ({ basis: 'TEMPORAL_COACTIVITY', size: c.length, authors: c.map(hash).sort() })),
    ...dupClusters.map((c) => ({ basis: 'NEAR_DUPLICATE_TEXT', size: c.length, authors: c.map(hash).sort() })),
  ];
  const suspected = bursts.length > 0 && clusters.length > 0;
  return makeResult({
    engine: ENGINE, modelId: 'M52.coordination', status: suspected ? STATUS.SIGNAL : STATUS.NO_SIGNAL,
    value: { label: suspected ? 'COORDINATED_ACTIVITY_SUSPECTED' : 'NO_COORDINATION_PATTERN', bursts, clusters, nearDuplicatePairs: dupEdges.length, coActivityPairsSignificant: edges.length, disclaimer: DISCLAIMER },
    coverage: coverageOf(1, 1), calibration: CALIBRATION.UNCALIBRATED, parameters: P, notes: [DISCLAIMER, 'author keys are salted hashes at cluster level; no individual ranking'],
  });
}
