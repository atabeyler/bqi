/**
 * Elliptic transaction-flow graph structure.
 * Edge topology (who paid whom) is public/static and carries no ground-truth
 * label information, so it is built from the full edge list. Any *label*
 * pulled into a neighbor-aggregate feature, however, must come only from
 * known TRAIN labels -- never from validation/development/holdout labels --
 * otherwise a node's score would be built partly from another split's
 * ground truth, which is leakage even when it never touches threshold or
 * architecture selection.
 */

const EMPTY = new Set();

export function buildAdjacency(edges) {
  const out = new Map();
  const inn = new Map();
  const undirected = new Map();
  const add = (map, a, b) => {
    let set = map.get(a);
    if (!set) { set = new Set(); map.set(a, set); }
    set.add(b);
  };
  for (const [a, b] of edges) {
    if (!a || !b) continue;
    add(out, a, b);
    add(inn, b, a);
    add(undirected, a, b);
    add(undirected, b, a);
  }
  return { out, inn, undirected };
}

/** Known-label lookup restricted to one dataset part (illicit=1, licit=0). */
export function knownLabelMap(part) {
  const map = new Map();
  for (const sample of part.samples) {
    const label = part.labels.get(sample.id) || 'unknown';
    if (label === 'unknown') continue;
    map.set(sample.id, label === 'illicit' ? 1 : 0);
  }
  return map;
}

function oneHopStats(id, undirected, trainLabelMap) {
  const neighbors = undirected.get(id);
  if (!neighbors || !neighbors.size) return { count: 0, known: 0, illicit: 0 };
  let known = 0;
  let illicit = 0;
  for (const n of neighbors) {
    const y = trainLabelMap.get(n);
    if (y === undefined) continue;
    known++;
    if (y === 1) illicit++;
  }
  return { count: neighbors.size, known, illicit };
}

function twoHopStats(id, undirected, trainLabelMap) {
  const oneHop = undirected.get(id);
  if (!oneHop || !oneHop.size) return { count: 0, known: 0, illicit: 0 };
  const visited = new Set(oneHop);
  visited.add(id);
  let count = 0;
  let known = 0;
  let illicit = 0;
  for (const n of oneHop) {
    const neighborsOfN = undirected.get(n);
    if (!neighborsOfN) continue;
    for (const n2 of neighborsOfN) {
      if (visited.has(n2)) continue;
      visited.add(n2);
      count++;
      const y = trainLabelMap.get(n2);
      if (y === undefined) continue;
      known++;
      if (y === 1) illicit++;
    }
  }
  return { count, known, illicit };
}

/**
 * Deterministic graph feature vector for one node id. Every ratio is
 * computed against TRAIN-only known labels so the same feature function is
 * safe to call on train, validation, development, or holdout nodes without
 * leaking their own split's ground truth back into their score.
 */
export function graphFeatureVector(id, adjacency, trainLabelMap) {
  const { out, inn, undirected } = adjacency;
  const outDeg = (out.get(id) || EMPTY).size;
  const inDegree = (inn.get(id) || EMPTY).size;
  const oneHop = oneHopStats(id, undirected, trainLabelMap);
  const twoHop = twoHopStats(id, undirected, trainLabelMap);
  return [
    inDegree,
    outDeg,
    inDegree + outDeg,
    oneHop.count,
    oneHop.known,
    oneHop.illicit,
    oneHop.known ? oneHop.illicit / oneHop.known : 0,
    twoHop.count,
    twoHop.known,
    twoHop.known ? twoHop.illicit / twoHop.known : 0,
  ];
}

/**
 * Personalized-PageRank-style label diffusion, seeded ONLY with TRAIN-known
 * labels. Every non-seed node's risk value is repeatedly re-averaged over its
 * current neighbor values, damped toward the train base rate each round, so
 * influence reaches many hops away without enumerating explicit k-hop
 * neighborhoods (which blows up combinatorially past 2 hops). Seed nodes stay
 * pinned to their TRAIN label on every iteration -- the same discipline as
 * the rest of this module: only TRAIN ground truth ever seeds a score, so
 * validation/development/holdout labels never leak through the graph, even
 * indirectly across iterations (a validation node's evolving field value is
 * always a function of train seeds propagated through public structure,
 * never of its own or another non-train node's true label).
 */
export function propagateIllicitRisk(adjacency, trainLabelMap, opts = {}) {
  const iterations = opts.iterations ?? 8;
  const restart = opts.restart ?? 0.15;
  let seedSum = 0;
  for (const y of trainLabelMap.values()) seedSum += y;
  const prior = trainLabelMap.size ? seedSum / trainLabelMap.size : 0.5;

  const nodes = new Set(adjacency.undirected.keys());
  for (const id of trainLabelMap.keys()) nodes.add(id);

  let field = new Map();
  for (const id of nodes) field.set(id, trainLabelMap.has(id) ? trainLabelMap.get(id) : prior);

  for (let iter = 0; iter < iterations; iter++) {
    const next = new Map();
    for (const id of nodes) {
      if (trainLabelMap.has(id)) { next.set(id, trainLabelMap.get(id)); continue; }
      const neighbors = adjacency.undirected.get(id);
      if (!neighbors || !neighbors.size) { next.set(id, field.get(id)); continue; }
      let sum = 0;
      for (const n of neighbors) sum += field.has(n) ? field.get(n) : prior;
      next.set(id, restart * prior + (1 - restart) * (sum / neighbors.size));
    }
    field = next;
  }
  return { field, prior };
}
