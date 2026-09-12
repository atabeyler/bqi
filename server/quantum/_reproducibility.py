"""
Shared reproducibility helpers for the quantum worker scripts (Q-04 in the
technical audit): every quantum result should carry enough metadata to
retrace it later -- not just "which Qiskit version" (environment_fingerprint,
already tracked separately), but a hash of the exact input that went in, the
exact circuit structure that ran, and the exact output that came out.
Comparing these hashes across two runs of the same input is the actual
reproducibility check.

Note this does NOT claim bit-identical re-runs are guaranteed -- the
scenario engine in particular is intentionally unseeded (see
scenario_quantum.py's module docstring), so its outputHash will differ
between runs of the same input by design. The hashes exist for audit
traceability (proving what a specific report's numbers came from), not as a
determinism guarantee.
"""
import hashlib
import json
import platform

import qiskit
import qiskit_aer


def environment_fingerprint():
    return {
        "qiskitVersion": qiskit.__version__,
        "qiskitAerVersion": qiskit_aer.__version__,
        "pythonVersion": platform.python_version(),
    }


def stable_hash(obj):
    """SHA-256 hex digest of a JSON-serializable value, canonicalized (sorted
    keys, compact separators, non-JSON-native types stringified) so the same
    logical input/output always hashes the same regardless of dict insertion
    order or numpy/qiskit scalar wrapper types."""
    encoded = json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def circuit_structure_hash(qc):
    """Hashes a QuantumCircuit's gate sequence (operation name, the qubit
    indices it acts on, and its parameters) -- independent of any particular
    QASM export API, which differs across Qiskit versions. Two circuits with
    the same gates in the same order on the same qubits hash identically
    regardless of object identity or how they were built."""
    ops = []
    for instr in qc.data:
        qubit_indices = [qc.find_bit(q).index for q in instr.qubits]
        params = [round(float(p), 10) if isinstance(p, (int, float)) else str(p) for p in instr.operation.params]
        ops.append({"op": instr.operation.name, "qubits": qubit_indices, "params": params})
    return stable_hash(ops)


def reproducibility_block(input_payload, qc, output_payload):
    """Builds the {inputHash, circuitHash, outputHash} block attached to a
    worker's result -- see module docstring. Call this with the OUTPUT dict
    as it stands before this block itself is added to it, otherwise the hash
    would depend on its own value."""
    return {
        "inputHash": stable_hash(input_payload),
        "circuitHash": circuit_structure_hash(qc),
        "outputHash": stable_hash(output_payload),
    }
