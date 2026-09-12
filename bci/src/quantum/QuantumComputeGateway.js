// Quantum Compute Gateway (spec section 5). No module outside src/quantum/
// ever imports a specific provider (IBM included) directly -- everything
// else in BCI (Security Graph Optimizer, Risk/Remediation Optimizer) talks
// to this gateway only, so swapping or adding a provider never touches
// them. This is the same "sensor, not the product" principle M5's
// EngineAdapter applies to scanners, applied here to compute backends.
//
// Provider contract:
//   {
//     id: string,                 // 'classical' | 'quantum_inspired' | 'quantum_simulator' | 'ibm_quantum'
//     mode: ComputeMode,          // what to LABEL any result this provider produces -- never mislabel a
//                                 // fallback result as if it came from the mode that was actually requested
//     async getProviderHealth(): { status: ProviderHealthStatus, detail?: string }
//     getCapabilities(): { supportsOptimization: boolean, maxProblemSize: number|null }
//     async submitOptimizationProblem(problem, options): OptimizationResult
//       -- problem: { items: [{id, value, cost}], budget: number }
//       -- local providers (classical/quantum-inspired/simulator) resolve
//          synchronously; a real remote provider (IBM hardware) would be
//          genuinely async, but still returns through this one method by
//          polling internally -- callers never see provider-specific job
//          handles.
//   }
export const COMPUTE_MODES = Object.freeze({
  CLASSICAL: 'CLASSICAL',
  QUANTUM_INSPIRED: 'QUANTUM_INSPIRED',
  QUANTUM_SIMULATOR: 'QUANTUM_SIMULATOR',
  QUANTUM_HARDWARE: 'QUANTUM_HARDWARE',
});

export const PROVIDER_HEALTH = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  DEGRADED: 'DEGRADED',
  UNAVAILABLE: 'UNAVAILABLE',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
});

export function assertValidProvider(provider) {
  const required = ['id', 'mode', 'getProviderHealth', 'getCapabilities', 'submitOptimizationProblem'];
  const missing = required.filter((k) => provider[k] === undefined);
  if (missing.length > 0) throw new Error(`Invalid quantum provider "${provider.id ?? '?'}": missing ${missing.join(', ')}`);
  if (!Object.values(COMPUTE_MODES).includes(provider.mode)) {
    throw new Error(`Invalid quantum provider "${provider.id}": unknown mode "${provider.mode}"`);
  }
}
