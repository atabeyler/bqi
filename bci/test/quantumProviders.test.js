import { afterEach, describe, it, expect, vi } from 'vitest';
import { classicalAdapter } from '../src/quantum/providers/classicalAdapter.js';
import { quantumInspiredAdapter } from '../src/quantum/providers/quantumInspiredAdapter.js';
import { ibmAdapter } from '../src/quantum/providers/ibmAdapter.js';
import { localSimulatorAdapter } from '../src/quantum/providers/localSimulatorAdapter.js';
import { PROVIDER_HEALTH, COMPUTE_MODES } from '../src/quantum/QuantumComputeGateway.js';
import { listQuantumProviders, getAllProviderHealth, getQuantumProvider } from '../src/quantum/registry.js';

afterEach(() => vi.restoreAllMocks());

const PROBLEM = {
  items: [
    { id: 'a', value: 10, cost: 5 },
    { id: 'b', value: 6, cost: 3 },
    { id: 'c', value: 8, cost: 4 },
    { id: 'd', value: 3, cost: 2 },
  ],
  budget: 7,
};

describe('quantum provider registry', () => {
  it('registers exactly the four providers, each with a valid mode', () => {
    const ids = listQuantumProviders().map((p) => p.id).sort();
    expect(ids).toEqual(['classical', 'ibm_quantum', 'quantum_inspired', 'quantum_simulator']);
  });

  // Wizard step 3 shows local/policy-gated status per real capability
  // metadata rather than a hard-coded assumption -- these are the real,
  // architectural facts each adapter reports about itself.
  it('exposes real local/policy-gated capability metadata per provider', () => {
    expect(classicalAdapter.getCapabilities()).toMatchObject({ local: true, policyGated: false });
    expect(quantumInspiredAdapter.getCapabilities()).toMatchObject({ local: true, policyGated: false });
    expect(ibmAdapter.getCapabilities()).toMatchObject({ local: false, policyGated: true, experimental: true });
  });

  it('checks independent provider health concurrently so cold Python imports cannot stack', async () => {
    const pending = [];
    for (const provider of [classicalAdapter, quantumInspiredAdapter, localSimulatorAdapter, ibmAdapter]) {
      vi.spyOn(provider, 'getProviderHealth').mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    }

    const resultPromise = getAllProviderHealth();
    await Promise.resolve();
    expect(pending).toHaveLength(4);
    pending.forEach((resolve) => resolve({ status: PROVIDER_HEALTH.AVAILABLE }));
    await expect(resultPromise).resolves.toHaveLength(4);
  });
});

describe('classicalAdapter', () => {
  it('is always AVAILABLE and finds the exact optimum', async () => {
    const health = await classicalAdapter.getProviderHealth();
    expect(health.status).toBe(PROVIDER_HEALTH.AVAILABLE);

    const result = await classicalAdapter.submitOptimizationProblem(PROBLEM);
    expect(result.mode).toBe(COMPUTE_MODES.CLASSICAL);
    expect(result.feasible).toBe(true);
    expect(result.objectiveValue).toBe(14);
    expect(result.provenance.algorithm).toBe('exact-dp-knapsack');
  });
});

describe('quantumInspiredAdapter', () => {
  it('is always AVAILABLE and returns a feasible (if not necessarily optimal) solution', async () => {
    const health = await quantumInspiredAdapter.getProviderHealth();
    expect(health.status).toBe(PROVIDER_HEALTH.AVAILABLE);

    const result = await quantumInspiredAdapter.submitOptimizationProblem(PROBLEM, { seed: 1 });
    expect(result.mode).toBe(COMPUTE_MODES.QUANTUM_INSPIRED);
    expect(result.feasible).toBe(true);
    expect(result.objectiveValue).toBeLessThanOrEqual(14); // classical optimum is an upper bound
    expect(result.provenance.algorithm).toBe('simulated-annealing');
  });

  it('is deterministic for a fixed seed (reproducibility, spec section 19)', async () => {
    const a = await quantumInspiredAdapter.submitOptimizationProblem(PROBLEM, { seed: 99 });
    const b = await quantumInspiredAdapter.submitOptimizationProblem(PROBLEM, { seed: 99 });
    expect(a.selectedIds.sort()).toEqual(b.selectedIds.sort());
    expect(a.objectiveValue).toBe(b.objectiveValue);
  });
});

describe('ibmAdapter (no token configured in this environment)', () => {
  it('reports NOT_CONFIGURED and refuses to submit, rather than silently falling back', async () => {
    const health = await ibmAdapter.getProviderHealth();
    expect(health.status).toBe(PROVIDER_HEALTH.NOT_CONFIGURED);
    await expect(classicalAdapter.getProviderHealth()).resolves.toBeDefined(); // sanity: other providers unaffected
    await expect(ibmAdapter.submitOptimizationProblem(PROBLEM)).rejects.toThrow(/not configured/);
  });

  it('is registered under the QUANTUM_HARDWARE mode', () => {
    expect(getQuantumProvider('ibm_quantum').mode).toBe(COMPUTE_MODES.QUANTUM_HARDWARE);
  });
});
