import { describe, it, expect } from 'vitest';
import { computeFraudRiskScores, mergeFraudResults } from './fraudDetection.js';

describe('computeFraudRiskScores', () => {
  it('returns null without spawning a process for fewer than 3 transactions', async () => {
    expect(await computeFraudRiskScores([])).toBeNull();
    expect(await computeFraudRiskScores([{ id: 'TXN-001' }])).toBeNull();
    expect(await computeFraudRiskScores(null)).toBeNull();
  });
});

describe('mergeFraudResults', () => {
  it('returns null when there is no fraud result', () => {
    expect(mergeFraudResults(null)).toBeNull();
    expect(mergeFraudResults({ transactions: [] })).toBeNull();
  });

  it('produces a verification note listing flagged and normal transactions', () => {
    const result = {
      backend: 'qiskit-statevector-kernel',
      qubits: 5,
      circuitDepth: 12,
      circuitDiagram: 'q_0: ┤ RY ├──■──',
      transactionCount: 2,
      flaggedCount: 1,
      transactions: [
        { id: 'TXN-001', amount: 15000.5, hour: 3, frequency: 4, newCounterparty: 1, crossBorder: 0, riskScore: 88.5, flagged: true },
        { id: 'TXN-002', amount: 250, hour: 14, frequency: 1, newCounterparty: 0, crossBorder: 1, riskScore: 12.1, flagged: false },
      ],
    };

    const note = mergeFraudResults(result);

    expect(note).toContain('KUANTUM ANOMALİ TESPİTİ DOĞRULAMASI');
    expect(note).toContain('5-kübitlik');
    expect(note).toContain('1 / 2 kayıt işaretlendi');
    expect(note).toContain('| TXN-001 | 15000.5 | 3 | 4 | Evet | Hayır | 88.5 | 🚩 İŞARETLENDİ |');
    expect(note).toContain('| TXN-002 | 250 | 14 | 1 | Hayır | Evet | 12.1 | — |');
    expect(note).toContain('q_0: ┤ RY ├──■──');
    expect(note).toContain('İkincil Onay Katmanı');
    expect(note).not.toContain('Gerçek Donanım Doğrulaması');
  });

  it('adds a real-hardware verification section when a swap test ran on IBM hardware', () => {
    // Regression coverage: computeFraudRiskScores() now optionally runs a
    // swap test on real IBM hardware (see fraud_detection.py) as a
    // verification-only data point for the top-risk vs. most-typical
    // transaction pair -- this must be surfaced in the report note without
    // altering the deterministic flagged/riskScore table above it.
    const result = {
      backend: 'qiskit-statevector-kernel',
      qubits: 5,
      circuitDepth: 12,
      circuitDiagram: 'q_0: ┤ RY ├──■──',
      transactionCount: 2,
      flaggedCount: 1,
      transactions: [
        { id: 'TXN-001', amount: 15000.5, hour: 3, frequency: 4, newCounterparty: 1, crossBorder: 0, riskScore: 88.5, flagged: true },
        { id: 'TXN-002', amount: 250, hour: 14, frequency: 1, newCounterparty: 0, crossBorder: 1, riskScore: 12.1, flagged: false },
      ],
      hardwareVerification: {
        backend: 'ibm_marrakesh',
        shots: 2048,
        pair: { a: 'TXN-001', b: 'TXN-002' },
        exactFidelity: 0.0979,
        measuredFidelity: 0.086,
      },
    };

    const note = mergeFraudResults(result);

    expect(note).toContain('Gerçek Donanım Doğrulaması');
    expect(note).toContain('ibm_marrakesh');
    expect(note).toContain('TXN-001');
    expect(note).toContain('TXN-002');
    expect(note).toContain('0.0979');
    expect(note).toContain('0.086');
    // The flagged/riskScore table itself must stay driven by the exact
    // simulator values, unaffected by the hardware verification numbers.
    expect(note).toContain('| TXN-001 | 15000.5 | 3 | 4 | Evet | Hayır | 88.5 | 🚩 İŞARETLENDİ |');
  });

  it('notes when a classical pre-filter picked the kernel candidates from a larger set', () => {
    const result = {
      backend: 'qiskit-statevector-kernel', qubits: 5, circuitDepth: 12, circuitDiagram: '',
      transactionCount: 60, flaggedCount: 3, prefiltered: true, excludedByPrefilter: 140,
      transactions: [{ id: 'TXN-1', amount: 100, hour: 1, frequency: 1, newCounterparty: 0, crossBorder: 0, riskScore: 90, flagged: true }],
    };
    const note = mergeFraudResults(result);
    expect(note).toContain('200 kayıt arasından');
    expect(note).toContain('en riskli görünen 60 kaydı');
  });

  it('adds a classical-benchmark comparison section when present', () => {
    const result = {
      backend: 'qiskit-statevector-kernel',
      qubits: 5,
      circuitDepth: 12,
      circuitDiagram: '',
      transactionCount: 3,
      flaggedCount: 1,
      transactions: [
        { id: 'TXN-001', amount: 15000, hour: 3, frequency: 4, newCounterparty: 1, crossBorder: 0, riskScore: 90, flagged: true },
        { id: 'TXN-002', amount: 250, hour: 14, frequency: 1, newCounterparty: 0, crossBorder: 1, riskScore: 10, flagged: false },
        { id: 'TXN-003', amount: 300, hour: 15, frequency: 1, newCounterparty: 0, crossBorder: 0, riskScore: 8, flagged: false },
      ],
      classicalBenchmark: {
        flaggedCount: 1,
        agreementCount: 3,
        agreementPercent: 100,
        quantumOnlyFlags: 0,
        classicalOnlyFlags: 0,
        method: 'euclidean-distance-from-centroid (mean+std threshold)',
      },
    };

    const note = mergeFraudResults(result);
    expect(note).toContain('Klasik Anomali Tespiti Karşılaştırması');
    expect(note).toContain('Uyum oranı: %100');
  });
});
