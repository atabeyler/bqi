import { describe, expect, it } from 'vitest';
import { buildAdjacency, graphFeatureVector, knownLabelMap, propagateIllicitRisk } from './ellipticGraph.js';

describe('ellipticGraph', () => {
  it('builds directed and undirected adjacency from edges', () => {
    const { out, inn, undirected } = buildAdjacency([['a', 'b'], ['a', 'c']]);
    expect(out.get('a')).toEqual(new Set(['b', 'c']));
    expect(inn.get('b')).toEqual(new Set(['a']));
    expect(undirected.get('b')).toEqual(new Set(['a']));
    expect(undirected.get('a')).toEqual(new Set(['b', 'c']));
  });

  it('keeps only known labels in a part', () => {
    const part = { samples: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], labels: new Map([['a', 'illicit'], ['b', 'licit']]) };
    const map = knownLabelMap(part);
    expect(map.get('a')).toBe(1);
    expect(map.get('b')).toBe(0);
    expect(map.has('c')).toBe(false);
  });

  it('computes degree and train-only 1-hop/2-hop illicit ratios', () => {
    // a -- b(illicit,train) -- d(unlabeled)
    // a -- c(licit,train)
    const adjacency = buildAdjacency([['a', 'b'], ['a', 'c'], ['b', 'd']]);
    const trainLabelMap = new Map([['b', 1], ['c', 0]]);
    const [inDeg, outDeg, degree, oneHopCount, oneHopKnown, oneHopIllicit, oneHopRatio, twoHopCount, twoHopKnown, twoHopRatio] =
      graphFeatureVector('a', adjacency, trainLabelMap);
    expect(inDeg).toBe(0);
    expect(outDeg).toBe(2);
    expect(degree).toBe(2);
    expect(oneHopCount).toBe(2);
    expect(oneHopKnown).toBe(2);
    expect(oneHopIllicit).toBe(1);
    expect(oneHopRatio).toBe(0.5);
    expect(twoHopCount).toBe(1); // d, reached via b
    expect(twoHopKnown).toBe(0); // d has no train label
    expect(twoHopRatio).toBe(0);
  });

  it('never lets a non-train label leak into the neighbor ratio', () => {
    // e's only neighbor f is labeled illicit, but only in validation -- so
    // trainLabelMap (built from knownLabelMap(trainPart)) must not contain it.
    const adjacency = buildAdjacency([['e', 'f']]);
    const trainPart = { samples: [{ id: 'e' }], labels: new Map() }; // f never appears in train
    const trainLabelMap = knownLabelMap(trainPart);
    const [, , , , oneHopKnown, oneHopIllicit, oneHopRatio] = graphFeatureVector('e', adjacency, trainLabelMap);
    expect(oneHopKnown).toBe(0);
    expect(oneHopIllicit).toBe(0);
    expect(oneHopRatio).toBe(0);
  });

  it('returns zeroed stats for a node absent from the edge list', () => {
    const adjacency = buildAdjacency([['a', 'b']]);
    const vector = graphFeatureVector('isolated', adjacency, new Map());
    expect(vector).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  describe('propagateIllicitRisk', () => {
    it('pins TRAIN seeds to their own label on every iteration', () => {
      const adjacency = buildAdjacency([['seed-illicit', 'x'], ['seed-licit', 'x']]);
      const trainLabelMap = new Map([['seed-illicit', 1], ['seed-licit', 0]]);
      const { field } = propagateIllicitRisk(adjacency, trainLabelMap, { iterations: 5 });
      expect(field.get('seed-illicit')).toBe(1);
      expect(field.get('seed-licit')).toBe(0);
    });

    it('gives a node next to an illicit seed a higher risk than one next to a licit seed', () => {
      // near-illicit -- illicit-seed        near-licit -- licit-seed
      const adjacency = buildAdjacency([['near-illicit', 'illicit-seed'], ['near-licit', 'licit-seed']]);
      const trainLabelMap = new Map([['illicit-seed', 1], ['licit-seed', 0]]);
      const { field } = propagateIllicitRisk(adjacency, trainLabelMap, { iterations: 6 });
      expect(field.get('near-illicit')).toBeGreaterThan(field.get('near-licit'));
    });

    it('never lets a non-train label seed the diffusion, even indirectly', () => {
      // f is illicit only in validation -- knownLabelMap(trainPart) must exclude it,
      // so it can never anchor the field the way a real TRAIN seed does.
      const adjacency = buildAdjacency([['e', 'f'], ['f', 'g']]);
      const trainPart = { samples: [{ id: 'e' }], labels: new Map() };
      const trainLabelMap = knownLabelMap(trainPart);
      const { field, prior } = propagateIllicitRisk(adjacency, trainLabelMap, { iterations: 5 });
      expect(trainLabelMap.has('f')).toBe(false);
      expect(field.get('e')).toBeCloseTo(prior, 5);
    });

    it('decays a distant node toward the train base rate rather than a fixed seed value', () => {
      // A long chain from an illicit seed: risk should be high near the seed and
      // fade toward the prior as distance grows, never staying pinned at 1. A
      // second, unconnected licit seed only shifts the prior (0.5) -- it never
      // touches the chain through an edge, so any influence on chain nodes
      // must come from the restart-toward-prior term, not from graph structure.
      const chain = [];
      for (let i = 0; i < 20; i++) chain.push([`n${i}`, `n${i + 1}`]);
      const adjacency = buildAdjacency(chain);
      const trainLabelMap = new Map([['n0', 1], ['unconnected-licit-seed', 0]]);
      const { field, prior } = propagateIllicitRisk(adjacency, trainLabelMap, { iterations: 8 });
      expect(prior).toBe(0.5);
      expect(field.get('n1')).toBeGreaterThan(field.get('n10'));
      expect(field.get('n19')).toBeCloseTo(prior, 1);
    });
  });
});
