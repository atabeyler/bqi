import { COMPUTE_MODES, PROVIDER_HEALTH } from '../QuantumComputeGateway.js';
import { runPythonQuantumScript, checkPythonModule } from '../pythonBridge.js';

// A real local quantum circuit simulator (Qiskit + qiskit-aer's
// AerSimulator, spawned via quantum/optimize_knapsack_qaoa.py) -- QAOA
// actually runs, actually gets sampled, and the result is not a stub. This
// is BCI's OWN Python/Qiskit environment (bci/quantum/requirements.txt),
// deliberately not shared with BQI's server/quantum/ -- no import,
// no shared virtualenv, so upgrading one can never break the other.
const MAX_ITEMS = 10; // realistic ceiling for a QUBO simulated on a laptop-class CPU

export const localSimulatorAdapter = {
  id: 'quantum_simulator',
  mode: COMPUTE_MODES.QUANTUM_SIMULATOR,

  async getProviderHealth() {
    const check = await checkPythonModule('qiskit_aer');
    if (!check.ok) return { status: PROVIDER_HEALTH.NOT_CONFIGURED, detail: check.error };
    return { status: PROVIDER_HEALTH.AVAILABLE };
  },

  getCapabilities() {
    // local:true -- the AerSimulator subprocess runs on this machine, no
    // data leaves it. policyGated:true -- still requires an explicit org
    // opt-in (allowQuantumSimulator) even though it's local, matching the
    // documented "admin opt-in even though local" product decision.
    return { supportsOptimization: true, maxProblemSize: MAX_ITEMS, local: true, policyGated: true };
  },

  async submitOptimizationProblem({ items, budget }, { reps = 2, shots = 2048, seed = 42, timeoutMs = 90_000 } = {}) {
    if (items.length > MAX_ITEMS) {
      throw new Error(`problem too large for the local simulator (${items.length} items > ${MAX_ITEMS} max)`);
    }
    const startedAt = Date.now();
    const result = await runPythonQuantumScript('optimize_knapsack_qaoa.py', { items, budget, reps, shots, seed }, { timeoutMs });
    return {
      selectedIds: result.selectedIds,
      objectiveValue: result.objectiveValue,
      feasible: result.feasible,
      mode: COMPUTE_MODES.QUANTUM_SIMULATOR,
      provenance: {
        algorithm: result.algorithm,
        backend: result.backend,
        qubits: result.qubits,
        shots: result.shots,
        circuitDepth: result.circuitDepth,
        seed: result.seed,
        qiskitVersion: result.qiskitVersion,
        qiskitAerVersion: result.qiskitAerVersion,
        computeTimeMs: Date.now() - startedAt,
      },
    };
  },
};
