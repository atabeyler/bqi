"""
BQI Quantum Scenario Engine
----------------------------------
Loads the scenario weights produced by the LLM into a quantum circuit as
amplitudes, applies quantum interference through a multi-layer, fully
entangling mixer, and computes the final probability distribution by
running the circuit several independent times (batches) so the result
carries a genuine shot-noise-derived spread across those batches (mean ±1
standard deviation -- NOT a statistical confidence interval), not a single
point estimate.

This runs a REAL quantum circuit -- but on a local SIMULATOR (Qiskit Aer).
It is not real quantum hardware (IBM Quantum, etc.); this distinction is
always made explicit in this script's output and in the Node service that
calls it, via the "qiskit-aer-simulator" backend name.

BQI-006 (quantum output semantics): "quantumProbability" (and the client's
label "Kuantum Dönüşümlü Senaryo Dağılımı" / "Quantum-transformed scenario
distribution") is a measurement-outcome frequency from re-expressing the
LLM's own probability estimate as circuit amplitudes and re-measuring it --
it is NOT an independent real-world measurement and NOT a validated
event-occurrence probability. Nothing here or downstream (server/src/
middleware/analysisTrace.js, client/src/components/QuantumCharts.jsx,
AnalysisView.jsx) should ever present it as the latter.

Input:  JSON via stdin -> {"shots": 4096, "scenarios": [{"id": "...", "weight": 0.42}, ...]}
Output: JSON via stdout -> {"backend", "qubits", "shots", "batches", "circuitDepth",
                            "circuitDiagram", "phantomStateMass", "environmentFingerprint",
                            "scenarios": [...]}
"""
import sys
import json
import math
import statistics

from qiskit import QuantumCircuit, QuantumRegister, ClassicalRegister, transpile
from qiskit_aer import AerSimulator

from _ibm_backend import run_on_ibm_hardware, is_ibm_configured, LAST_IBM_ERROR
from _reproducibility import environment_fingerprint, reproducibility_block

# Multi-layer, all-pairs entangling mixer: each layer connects every qubit
# to every other qubit (not just neighbors) via CRX, followed by a per-qubit
# RY. The angle decays slightly across layers so later layers refine rather
# than re-randomize the distribution. Tuned empirically (see commit history)
# so that a clear front-runner scenario stays the front-runner after
# interference -- only near-ties are close enough to flip, which is the
# statistically honest outcome for near-tied inputs, not a circuit bug.
NUM_LAYERS = 3
BASE_MIX_ANGLE = 0.08
LAYER_DECAY = 0.15

# Independent circuit executions used to build a confidence interval on the
# quantum result, instead of reporting a single shot batch as if it had no
# sampling error.
NUM_BATCHES = 5
MIN_BATCH_SHOTS = 256

# Bounds on the client-controlled `shots` input -- unlike MAX_TRANSACTIONS in
# fraud_detection.py and MAX_ITEMS in portfolio_optimizer.py, this had no
# ceiling, so an arbitrarily large value scaled batch_shots (and therefore
# simulator work) with no limit.
MIN_SHOTS = 256
MAX_SHOTS = 20000

# Mirrors MAX_TRANSACTIONS in fraud_detection.py and MAX_ITEMS in
# portfolio_optimizer.py -- without a cap, an unusually large LLM-produced
# scenario table would reach this script with no upper bound on qubit count
# or crx-pair mixer work.
MAX_SCENARIOS = 32

def build_mixer(qc, num_qubits):
    """Applies the multi-layer entangling mixer in place; returns a
    description of each layer for the circuit-transparency note."""
    layers = []
    for layer in range(NUM_LAYERS):
        angle = BASE_MIX_ANGLE * (1 - layer * LAYER_DECAY)
        pairs = []
        for q1 in range(num_qubits):
            for q2 in range(q1 + 1, num_qubits):
                qc.crx(angle, q1, q2)
                pairs.append([q1, q2])
        for q in range(num_qubits):
            qc.ry(angle / 3, q)
        if layer < NUM_LAYERS - 1:
            qc.barrier()
        layers.append({"layer": layer + 1, "angle": round(angle, 4), "entangledPairs": pairs})
    return layers


def build_distribution(scenarios, shots, skip_hardware=False):
    n = len(scenarios)
    if n == 0:
        return None

    num_qubits = max(1, math.ceil(math.log2(n)))
    dim = 2 ** num_qubits

    raw_weights = [max(1e-6, float(s.get("weight") or 0) or (1.0 / n)) for s in scenarios]
    total = sum(raw_weights)
    llm_probs = [w / total for w in raw_weights]

    # Amplitude encoding: the square root of each scenario's probability becomes its quantum amplitude.
    amplitudes = [0.0] * dim
    for i, p in enumerate(llm_probs):
        amplitudes[i] = math.sqrt(p)
    norm = math.sqrt(sum(a * a for a in amplitudes)) or 1.0
    amplitudes = [a / norm for a in amplitudes]

    # Classical register is explicitly named "meas" (not the QuantumCircuit
    # default "c") so it matches what qc.measure_all() produces elsewhere --
    # the IBM Runtime result reader (_ibm_backend.py) looks up this name.
    qc = QuantumCircuit(QuantumRegister(num_qubits, 'q'), ClassicalRegister(num_qubits, 'meas'))
    qc.initialize(amplitudes, range(num_qubits))

    mixer_layers = build_mixer(qc, num_qubits)

    qc.measure(range(num_qubits), range(num_qubits))

    backend = AerSimulator()
    tqc = transpile(qc, backend)

    # Run NUM_BATCHES independent executions rather than one big shot pool,
    # so the spread between batches is a real, honest sampling-noise signal.
    batch_shots = max(MIN_BATCH_SHOTS, shots // NUM_BATCHES)
    batch_percentages = []  # [batch][scenario] -> percentage
    total_measured = [0] * dim
    for _ in range(NUM_BATCHES):
        result = backend.run(tqc, shots=batch_shots).result()
        counts = result.get_counts()
        tallies = [0] * dim
        for bitstring, c in counts.items():
            idx = int(bitstring, 2)
            if idx < dim:
                tallies[idx] += c
                total_measured[idx] += c
        # Normalize against the real scenarios only (indices 0..n-1). When n
        # isn't a power of two, dim > n and the entangling mixer can rotate
        # a sliver of amplitude into the extra "phantom" basis states that
        # don't correspond to any scenario -- counting those in the
        # denominator would make every reported percentage quietly sum to
        # less than 100%.
        total_b = sum(tallies[:n]) or 1
        batch_percentages.append([tallies[i] / total_b * 100 for i in range(dim)])

    out = []
    for i, s in enumerate(scenarios):
        vals = [batch_percentages[b][i] for b in range(NUM_BATCHES)]
        mean_p = statistics.mean(vals)
        stdev_p = statistics.stdev(vals) if len(vals) > 1 else 0.0
        out.append({
            "id": s.get("id"),
            "llmEstimate": round(llm_probs[i] * 100, 1),
            "quantumProbability": round(mean_p, 1),
            "quantumStdDev": round(stdev_p, 1),
            "quantumRangeLow": round(max(0.0, mean_p - stdev_p), 1),
            "quantumRangeHigh": round(min(100.0, mean_p + stdev_p), 1),
            "shots": total_measured[i] if i < dim else 0,
        })

    diagram = str(qc.draw(output="text", fold=80))

    # Fraction of all measured shots that landed in a basis state beyond the
    # real scenarios (indices n..dim-1) -- only possible when n isn't a
    # power of two (see the phantom-state note above). Reported so callers
    # can see how much of the circuit's raw output was renormalized away,
    # instead of that being invisible inside the per-scenario percentages.
    total_all = sum(total_measured) or 1
    phantom_state_mass = round(sum(total_measured[n:]) / total_all, 4) if dim > n else 0.0

    # Optional: run the same circuit once more on real IBM Quantum hardware
    # as a separate verification data point. Kept out of the confidence
    # interval above -- hardware noise (readout error, decoherence) isn't
    # the same kind of noise as simulator shot statistics, so blending them
    # into one average would misrepresent both.
    hardware_verification = None
    # Diagnostic-only: reported alongside hardwareVerification so the
    # quantum-status health check can tell "not configured" apart from
    # "configured but the hardware attempt failed" (and why).
    ibm_diagnostic = "not configured (IBM_QUANTUM_TOKEN/IBM_QUANTUM_INSTANCE unset)"
    if skip_hardware:
        ibm_diagnostic = "skipped (fast simulator-only response; hardware verification runs separately)"
    elif is_ibm_configured():
        ibm_diagnostic = "configured, attempting hardware run..."
        ibm_result = run_on_ibm_hardware(qc, batch_shots)
        if ibm_result:
            counts, backend_name = ibm_result
            tallies = [0] * dim
            for bitstring, c in counts.items():
                idx = int(bitstring.replace(' ', ''), 2)
                if idx < dim:
                    tallies[idx] += c
            total_hw = sum(tallies) or 1
            hardware_verification = {
                "backend": backend_name,
                "shots": total_hw,
                "scenarios": [
                    {"id": s.get("id"), "quantumProbability": round(tallies[i] / total_hw * 100, 1)}
                    for i, s in enumerate(scenarios)
                ],
            }
            ibm_diagnostic = f"succeeded on {backend_name}"
        else:
            ibm_diagnostic = f"configured but failed: {LAST_IBM_ERROR['message'] or 'unknown error'}"

    result = {
        "backend": "qiskit-aer-simulator",
        "qubits": num_qubits,
        "shots": batch_shots * NUM_BATCHES,
        "batches": NUM_BATCHES,
        "circuitDepth": qc.depth(),
        "mixerLayers": mixer_layers,
        "circuitDiagram": diagram,
        "phantomStateMass": phantom_state_mass,
        "environmentFingerprint": environment_fingerprint(),
        "scenarios": out,
        "hardwareVerification": hardware_verification,
        "ibmDiagnostic": ibm_diagnostic,
    }
    result["reproducibility"] = reproducibility_block({"scenarios": scenarios, "shots": shots}, qc, out)
    return result


def main():
    raw = sys.stdin.read() or "{}"
    payload = json.loads(raw)
    scenarios = payload.get("scenarios", [])[:MAX_SCENARIOS]
    shots = min(MAX_SHOTS, max(MIN_SHOTS, int(payload.get("shots") or 4096)))
    skip_hardware = bool(payload.get("skipHardware"))

    result = build_distribution(scenarios, shots, skip_hardware)
    print(json.dumps(result if result is not None else {
        "backend": "qiskit-aer-simulator", "qubits": 0, "shots": 0,
        "batches": 0, "circuitDepth": 0, "mixerLayers": [], "circuitDiagram": "",
        "phantomStateMass": 0.0, "environmentFingerprint": environment_fingerprint(),
        "scenarios": [], "reproducibility": None,
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 -- the Node side logs stderr and falls back
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)
