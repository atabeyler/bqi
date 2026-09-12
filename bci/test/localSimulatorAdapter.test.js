import { describe, it, expect } from 'vitest';
import { localSimulatorAdapter } from '../src/quantum/providers/localSimulatorAdapter.js';
import { PROVIDER_HEALTH, COMPUTE_MODES } from '../src/quantum/QuantumComputeGateway.js';

const PROBLEM = {
  items: [
    { id: 'a', value: 10, cost: 5 },
    { id: 'b', value: 6, cost: 3 },
    { id: 'c', value: 8, cost: 4 },
    { id: 'd', value: 3, cost: 2 },
  ],
  budget: 7,
};

async function ifHealthy() {
  return (await localSimulatorAdapter.getProviderHealth()).status === PROVIDER_HEALTH.AVAILABLE;
}

describe('localSimulatorAdapter — real Qiskit/qiskit-aer QAOA (skips if qiskit-aer is not installed)', () => {
  it('reports capabilities with a bounded max problem size', () => {
    const caps = localSimulatorAdapter.getCapabilities();
    expect(caps.supportsOptimization).toBe(true);
    expect(caps.maxProblemSize).toBeGreaterThan(0);
  });

  it('runs a real QAOA circuit and finds the exact optimum on an easy instance, with full provenance', async () => {
    if (!(await ifHealthy())) return;

    const result = await localSimulatorAdapter.submitOptimizationProblem(PROBLEM, { seed: 7, shots: 1024, reps: 2 });

    expect(result.mode).toBe(COMPUTE_MODES.QUANTUM_SIMULATOR);
    expect(result.feasible).toBe(true);
    expect(result.objectiveValue).toBe(14); // matches the classical/exact optimum for this instance
    expect(result.provenance.algorithm).toBe('QAOA');
    expect(result.provenance.backend).toBe('aer_simulator');
    expect(result.provenance.qubits).toBeGreaterThan(0);
    expect(result.provenance.qiskitVersion).toBeDefined();
  }, 60_000);

  it('refuses a problem larger than its qubit ceiling rather than silently truncating it', async () => {
    const tooBig = { items: Array.from({ length: 20 }, (_, i) => ({ id: `f${i}`, value: i + 1, cost: 1 })), budget: 5 };
    await expect(localSimulatorAdapter.submitOptimizationProblem(tooBig)).rejects.toThrow(/too large/);
  });
});
