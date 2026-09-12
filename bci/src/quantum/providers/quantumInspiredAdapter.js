import { COMPUTE_MODES, PROVIDER_HEALTH } from '../QuantumComputeGateway.js';
import { evaluateSelection } from '../knapsack.js';

// "Quantum-inspired" (spec section 7-8): a simulated-annealing metaheuristic
// -- the same algorithm class real digital/quantum annealers (D-Wave,
// Fujitsu Digital Annealer) implement in specialized hardware, run here as
// plain classical code. Always available (no external dependency), and a
// genuine heuristic: it is NOT guaranteed to find the optimum the way
// classicalAdapter's exact DP is, which is exactly why the Benchmark
// Engine compares them rather than assuming either wins.
function penalizedObjective(items, x, budget, penalty) {
  let value = 0;
  let cost = 0;
  for (let i = 0; i < items.length; i++) {
    if (x[i]) { value += items[i].value; cost += items[i].cost; }
  }
  const overage = Math.max(0, cost - budget);
  return { score: value - penalty * overage * overage, value, cost, feasible: cost <= budget };
}

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function simulatedAnnealingKnapsack(items, budget, { iterations = 2000, seed = 42 } = {}) {
  const rand = mulberry32(seed);
  const n = items.length;
  const maxValue = items.reduce((s, it) => s + Math.abs(it.value), 0) || 1;
  const penalty = maxValue * 4 + 10;

  let x = items.map(() => rand() < 0.5);
  let current = penalizedObjective(items, x, budget, penalty);
  let best = { ...current, x: [...x] };

  for (let step = 0; step < iterations; step++) {
    const temperature = 1 - step / iterations;
    const flip = Math.floor(rand() * n);
    const candidate = [...x];
    candidate[flip] = !candidate[flip];
    const candidateScore = penalizedObjective(items, candidate, budget, penalty);

    const delta = candidateScore.score - current.score;
    if (delta >= 0 || rand() < Math.exp(delta / Math.max(temperature, 1e-6))) {
      x = candidate;
      current = candidateScore;
      if ((current.feasible && (!best.feasible || current.value > best.value)) ||
          (!best.feasible && current.score > best.score)) {
        best = { ...current, x: [...x] };
      }
    }
  }

  const selectedIds = items.filter((_, i) => best.x[i]).map((it) => it.id);
  return { selectedIds, objectiveValue: best.value, feasible: best.feasible, iterations };
}

export const quantumInspiredAdapter = {
  id: 'quantum_inspired',
  mode: COMPUTE_MODES.QUANTUM_INSPIRED,

  async getProviderHealth() {
    return { status: PROVIDER_HEALTH.AVAILABLE };
  },

  getCapabilities() {
    // local:true, policyGated:false -- never leaves the machine, so the
    // org's external-quantum policy (allowQuantumSimulator/allowQuantumHardware)
    // never gates it (see executionPolicy.js's decideExecutionMode).
    return { supportsOptimization: true, maxProblemSize: 500, local: true, policyGated: false };
  },

  async submitOptimizationProblem({ items, budget }, { seed = 42 } = {}) {
    const startedAt = Date.now();
    const result = simulatedAnnealingKnapsack(items, budget, { seed });
    const check = evaluateSelection(items, result.selectedIds, budget);
    return {
      selectedIds: result.selectedIds,
      objectiveValue: result.objectiveValue,
      feasible: check.feasible,
      mode: COMPUTE_MODES.QUANTUM_INSPIRED,
      provenance: {
        algorithm: 'simulated-annealing',
        algorithmVersion: 1,
        iterations: result.iterations,
        seed,
        environment: `node ${process.version}`,
        computeTimeMs: Date.now() - startedAt,
      },
    };
  },
};
