import { COMPUTE_MODES, PROVIDER_HEALTH } from '../QuantumComputeGateway.js';
import { runPythonQuantumScript, checkPythonModule } from '../pythonBridge.js';
import { config } from '../../config.js';

// spec section 6: "IBM credentials: environment/secret manager üzerinden
// alınmalı; hiçbir zaman DB plaintext olarak tutulmamalı; hiçbir zaman
// loglanmamalı; hiçbir zaman API response içinde gösterilmemeli." The token
// is read from env here and passed to the Python subprocess over stdin
// (never a CLI arg, which would appear in `ps`, and never written to any
// log line in this file).
const MAX_ITEMS = 12;

export const ibmAdapter = {
  id: 'ibm_quantum',
  mode: COMPUTE_MODES.QUANTUM_HARDWARE,

  async getProviderHealth() {
    if (!config.quantum.ibmToken) {
      return { status: PROVIDER_HEALTH.NOT_CONFIGURED, detail: 'BCI_IBM_QUANTUM_TOKEN not set' };
    }
    const check = await checkPythonModule('qiskit_ibm_runtime');
    if (!check.ok) return { status: PROVIDER_HEALTH.NOT_CONFIGURED, detail: check.error };
    // Deliberately does not make a real network call to IBM on every health
    // check (that would itself consume account quota/rate limit just to
    // report status) -- a genuine auth/availability failure still surfaces
    // through submitOptimizationProblem(), which every caller already
    // handles.
    return { status: PROVIDER_HEALTH.DEGRADED, detail: 'configured but not independently verified against a live IBM Quantum account' };
  },

  getCapabilities() {
    // local:false -- the only provider whose problem data actually leaves
    // this machine (real IBM QPU/cloud). experimental:true -- code-complete
    // against the current IBM Quantum Platform SDK, but no live QPU
    // execution has been validated yet; see README's "IBM Quantum:
    // EXPERIMENTAL -- LIVE QPU VALIDATION PENDING" status.
    return { supportsOptimization: true, maxProblemSize: MAX_ITEMS, local: false, policyGated: true, experimental: true };
  },

  async submitOptimizationProblem({ items, budget }, { reps = 1, shots = 1024, seed = 42, timeoutMs = 300_000 } = {}) {
    if (!config.quantum.ibmToken) {
      throw new Error('IBM Quantum is not configured (BCI_IBM_QUANTUM_TOKEN unset)');
    }
    if (items.length > MAX_ITEMS) {
      throw new Error(`problem too large for IBM Quantum hardware in this configuration (${items.length} items > ${MAX_ITEMS} max)`);
    }

    const startedAt = Date.now();
    const result = await runPythonQuantumScript(
      'ibm_backend.py',
      { items, budget, reps, shots, seed, token: config.quantum.ibmToken, instance: config.quantum.ibmInstance || undefined },
      { timeoutMs }
    );

    return {
      selectedIds: result.selectedIds,
      objectiveValue: result.objectiveValue,
      feasible: result.feasible,
      mode: COMPUTE_MODES.QUANTUM_HARDWARE,
      provenance: {
        algorithm: result.algorithm,
        backend: result.backend,
        hardware: true,
        qubits: result.qubits,
        shots: result.shots,
        circuitDepth: result.circuitDepth,
        seed: result.seed,
        qiskitVersion: result.qiskitVersion,
        ibmJobId: result.jobId,
        computeTimeMs: Date.now() - startedAt,
      },
    };
  },
};
