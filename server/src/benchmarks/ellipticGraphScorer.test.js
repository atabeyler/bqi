import { describe, expect, it } from 'vitest';
import { createGraphAwareScorer } from './ellipticGraphScorer.js';

function part(entries) {
  const samples = entries.map(([id]) => ({ id, source: 'elliptic', features: [] }));
  const labels = new Map(entries.map(([id, label]) => [id, label]));
  return { samples, labels };
}

describe('ellipticGraphScorer', () => {
  it('scores nodes wired to illicit train neighborhoods higher than isolated licit nodes', async () => {
    // Two illicit hubs (h1, h2) each with several illicit satellites; a
    // licit cluster of the same size; and a held-out node connected only to
    // the illicit hub -- the scorer never sees its own features, only graph
    // position relative to TRAIN-known neighbors.
    const trainEntries = [];
    const edges = [];
    for (let i = 0; i < 8; i++) {
      trainEntries.push([`illicit-${i}`, 'illicit']);
      edges.push(['hub-illicit', `illicit-${i}`]);
    }
    for (let i = 0; i < 8; i++) {
      trainEntries.push([`licit-${i}`, 'licit']);
      edges.push(['hub-licit', `licit-${i}`]);
    }
    trainEntries.push(['hub-illicit', 'illicit']);
    trainEntries.push(['hub-licit', 'licit']);
    const trainPart = part(trainEntries);

    edges.push(['hub-illicit', 'query-near-illicit']);
    edges.push(['hub-licit', 'query-near-licit']);

    const scorer = createGraphAwareScorer(trainPart, edges);
    const nearIllicit = await scorer({ id: 'query-near-illicit', source: 'elliptic', features: [] });
    const nearLicit = await scorer({ id: 'query-near-licit', source: 'elliptic', features: [] });
    expect(nearIllicit).toBeGreaterThan(nearLicit);
  });

  it('throws when no known labels are available to train on', () => {
    const trainPart = part([['a', 'unknown']]);
    expect(() => createGraphAwareScorer(trainPart, [])).toThrow();
  });
});
