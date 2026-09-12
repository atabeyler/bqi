import { describe, it, expect } from 'vitest';
import { buildEvidenceItems } from './evidence.js';

describe('buildEvidenceItems', () => {
  it('always includes the AI narrative claim, unverified', () => {
    const items = buildEvidenceItems({ provider: 'Claude (Anthropic)' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ claim: 'ai-narrative', engine: 'ai', source: 'Claude (Anthropic)', verified: false });
  });

  it('adds a top-scenario claim for the scenario quantum engine, carrying its inputHash', () => {
    const quantum = {
      backend: 'qiskit-aer-simulator',
      dataSource: 'ai-generated',
      scenarios: [
        { id: 'A', quantumProbability: 40 },
        { id: 'B', quantumProbability: 60 },
      ],
      classicalBenchmark: { topScenarioAgrees: true },
      reproducibility: { inputHash: 'abc123' },
    };
    const items = buildEvidenceItems({ provider: 'Claude', quantum });
    const scenarioItem = items.find((e) => e.engine === 'scenario-quantum');
    expect(scenarioItem).toMatchObject({
      claim: 'top-scenario',
      value: 'B',
      method: 'quantum-mixer-circuit (qiskit-aer-simulator)',
      confidence: 'agrees-with-classical-baseline',
      verified: false,
      inputDatasetHash: 'abc123',
    });
  });

  it('marks a claim verified when the engine result was confirmed on real IBM hardware', () => {
    const fraud = {
      backend: 'qiskit-statevector-kernel',
      flaggedCount: 3,
      hardwareVerification: { backend: 'ibm_brisbane' },
      classicalBenchmark: { agreementPercent: 87.5 },
    };
    const items = buildEvidenceItems({ provider: 'Claude', fraud });
    const fraudItem = items.find((e) => e.engine === 'fraud-quantum-kernel');
    expect(fraudItem.verified).toBe(true);
    expect(fraudItem.confidence).toBe('87.5% agreement with classical baseline');
  });

  it('adds a selected-allocation claim for the portfolio optimizer', () => {
    const optimizer = {
      backend: 'qiskit-aer-simulator',
      selected: ['I1', 'I3'],
      classicalBenchmark: { optimalityGapPercent: 0 },
    };
    const items = buildEvidenceItems({ provider: 'Claude', optimizer });
    const optItem = items.find((e) => e.engine === 'portfolio-qaoa');
    expect(optItem).toMatchObject({ claim: 'selected-allocation', value: ['I1', 'I3'], confidence: 'optimality gap 0%' });
  });
});
