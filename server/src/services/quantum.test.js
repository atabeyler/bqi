import { describe, it, expect } from 'vitest';
import { computeQuantumProbabilities, mergeQuantumResults } from './quantum.js';

describe('computeQuantumProbabilities', () => {
  it('returns null without spawning a process for an empty scenario list', async () => {
    expect(await computeQuantumProbabilities([])).toBeNull();
    expect(await computeQuantumProbabilities(null)).toBeNull();
  });
});

describe('mergeQuantumResults', () => {
  const scenarios = [
    { id: 'SENARYO-A', title: 'SENARYO-A (Birincil)', probability: '%42' },
    { id: 'SENARYO-B', title: 'SENARYO-B', probability: '%31' },
  ];

  it('returns the scenarios unchanged, with no note, when there is no quantum result', () => {
    const result = mergeQuantumResults(scenarios, null);
    expect(result.note).toBeNull();
    expect(result.scenarios).toBe(scenarios);
  });

  it('matches the quantum result against scenarios and produces a verification note', () => {
    const quantumResult = {
      backend: 'qiskit-aer-simulator',
      qubits: 1,
      shots: 2048,
      batches: 5,
      circuitDepth: 14,
      mixerLayers: [{ layer: 1 }, { layer: 2 }, { layer: 3 }],
      circuitDiagram: 'q_0: ┤0 Initialize ├──■──',
      scenarios: [
        { id: 'SENARYO-A', llmEstimate: 42, quantumProbability: 45.5, quantumStdDev: 1.2, quantumRangeLow: 44.3, quantumRangeHigh: 46.7 },
        { id: 'SENARYO-B', llmEstimate: 31, quantumProbability: 28.1, quantumStdDev: 0.9, quantumRangeLow: 27.2, quantumRangeHigh: 29.0 },
      ],
    };

    const { scenarios: merged, note, classicalBenchmark } = mergeQuantumResults(scenarios, quantumResult);

    expect(merged[0].quantumProbability).toBe(45.5);
    expect(merged[0].quantumStdDev).toBe(1.2);
    expect(merged[0].quantumRangeLow).toBe(44.3);
    expect(merged[1].llmEstimate).toBe(31);
    expect(note).toContain('KUANTUM DEVRE DOĞRULAMASI');
    expect(note).toContain('qiskit-aer-simulator');
    expect(note).toContain('yerel kuantum devre simülatörü');
    expect(note).toContain('%45.5');
    expect(note).toContain('%44.3 – %46.7');
    expect(note).toContain('3 katmanlı');
    expect(note).toContain('5 kez bağımsız');
    expect(note).toContain('q_0: ┤0 Initialize ├──■──');
    expect(note).toMatch(/```\nq_0:.*\n```/s);

    // Q-03: a classical (no-quantum) baseline comparison must always
    // accompany the quantum result -- here it's the LLM's raw estimate
    // ranking vs the post-mixer quantum ranking, same top scenario in
    // both (SENARYO-A), so this counts as agreement.
    expect(classicalBenchmark.topScenarioAgrees).toBe(true);
    expect(classicalBenchmark.classicalTopId).toBe('SENARYO-A');
    expect(classicalBenchmark.quantumTopId).toBe('SENARYO-A');
    expect(classicalBenchmark.meanAbsoluteDeviationPercent).toBeCloseTo(3.2, 1);
    expect(note).toContain('Klasik Tahmin Karşılaştırması');
    expect(note).toContain('En olası senaryo klasik (YZ) tahminiyle örtüşüyor');
  });

  it('flags disagreement in the classical benchmark when the quantum circuit changes which scenario ranks first', () => {
    const quantumResult = {
      backend: 'qiskit-aer-simulator', qubits: 1, shots: 2048, batches: 5, circuitDepth: 14, mixerLayers: [], circuitDiagram: '',
      scenarios: [
        { id: 'SENARYO-A', llmEstimate: 42, quantumProbability: 30 },
        { id: 'SENARYO-B', llmEstimate: 31, quantumProbability: 55 },
      ],
    };
    const { note, classicalBenchmark } = mergeQuantumResults(scenarios, quantumResult);
    expect(classicalBenchmark.topScenarioAgrees).toBe(false);
    expect(classicalBenchmark.classicalTopId).toBe('SENARYO-A');
    expect(classicalBenchmark.quantumTopId).toBe('SENARYO-B');
    expect(note).toContain('Kuantum devresi en olası senaryoyu değiştirdi');
  });

  it('leaves unmatched scenarios untouched', () => {
    const quantumResult = {
      backend: 'x', qubits: 1, shots: 1, batches: 1, circuitDepth: 1, mixerLayers: [], circuitDiagram: '',
      scenarios: [{ id: 'OTHER', llmEstimate: 1, quantumProbability: 1 }],
    };
    const { scenarios: merged } = mergeQuantumResults(scenarios, quantumResult);
    expect(merged).toEqual(scenarios);
  });
});
