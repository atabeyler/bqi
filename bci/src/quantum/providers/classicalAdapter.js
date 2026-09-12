import { COMPUTE_MODES, PROVIDER_HEALTH } from '../QuantumComputeGateway.js';
import { solveKnapsackExact } from '../knapsack.js';

// The default, always-available provider (spec section 7: "Default: LOCAL
// / CLASSICAL"). Exact, not a heuristic -- this is the baseline every
// other provider is benchmarked against (section 8).
export const classicalAdapter = {
  id: 'classical',
  mode: COMPUTE_MODES.CLASSICAL,

  async getProviderHealth() {
    return { status: PROVIDER_HEALTH.AVAILABLE };
  },

  getCapabilities() {
    return { supportsOptimization: true, maxProblemSize: null, local: true, policyGated: false };
  },

  async submitOptimizationProblem({ items, budget }) {
    const startedAt = Date.now();
    const { selectedIds, objectiveValue } = solveKnapsackExact(items, budget);
    return {
      selectedIds,
      objectiveValue,
      feasible: true,
      mode: COMPUTE_MODES.CLASSICAL,
      provenance: {
        algorithm: 'exact-dp-knapsack',
        algorithmVersion: 1,
        environment: `node ${process.version}`,
        computeTimeMs: Date.now() - startedAt,
      },
    };
  },
};
