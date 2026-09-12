import { assertValidProvider } from './QuantumComputeGateway.js';
import { classicalAdapter } from './providers/classicalAdapter.js';
import { quantumInspiredAdapter } from './providers/quantumInspiredAdapter.js';
import { localSimulatorAdapter } from './providers/localSimulatorAdapter.js';
import { ibmAdapter } from './providers/ibmAdapter.js';

const providers = new Map();
[classicalAdapter, quantumInspiredAdapter, localSimulatorAdapter, ibmAdapter].forEach((p) => {
  assertValidProvider(p);
  providers.set(p.id, p);
});

export function getQuantumProvider(id) {
  return providers.get(id) || null;
}

export function listQuantumProviders() {
  return [...providers.values()];
}

export async function getAllProviderHealth() {
  // Python-backed providers can each take several seconds on a cold
  // container. Running their independent checks serially could exceed the
  // gateway's 15s request timeout and leave the Wizard's Quantum step blank.
  return Promise.all([...providers.values()].map(async (provider) => {
    const health = await provider.getProviderHealth();
    return { id: provider.id, mode: provider.mode, ...health, capabilities: provider.getCapabilities() };
  }));
}
