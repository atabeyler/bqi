#!/usr/bin/env python3
"""
BCI Quantum Remediation Optimizer -- QAOA knapsack solver (local simulator).

Reads one JSON object from stdin:
  { "items": [{"id": str, "value": number, "cost": int}, ...],
    "budget": int, "reps": int (optional, default 2),
    "shots": int (optional, default 2048), "seed": int (optional) }

Solves: maximize sum(value_i * x_i) subject to sum(cost_i * x_i) <= budget,
x_i in {0,1} -- via QAOA on a local Aer simulator (qiskit-aer). This is a
REAL quantum circuit simulation, not a mock: the circuit is built,
transpiled, and sampled for real; only the classical outer-loop optimizer
(scipy COBYLA) driving the QAOA angles is classical, exactly as real QAOA
implementations work today (a NISQ-era hybrid algorithm, not a pure
quantum one). See ibm_backend.py for the same problem submitted to real
IBM Quantum hardware, and _qubo.py for the shared QUBO construction both
scripts use.

Writes one JSON object to stdout: the winning solution plus full
provenance metadata (spec section 19-20): algorithm, qiskit version,
backend, qubit count, shots, circuit depth, seed.
"""
import sys
import json

import numpy as np
from scipy.optimize import minimize

import qiskit
from qiskit import transpile
from qiskit_aer import AerSimulator
import qiskit_aer

from _qubo import build_qubo, qubo_to_ising, qaoa_circuit, best_feasible_from_counts


def expected_objective(counts, Q, total_shots, n_items, n_slack):
    total = 0.0
    for bits, count in counts.items():
        x = np.array([int(b) for b in bits[::-1]])
        total += float(x @ Q @ x) * count
    return total / total_shots


def main():
    payload = json.loads(sys.stdin.read())
    items = payload["items"]
    budget = int(payload["budget"])
    reps = int(payload.get("reps", 2))
    shots = int(payload.get("shots", 2048))
    seed = payload.get("seed", 42)

    if not items:
        print(json.dumps({"error": "no items provided"}))
        return

    Q, n_items, n_slack, _coeffs = build_qubo(items, budget)
    h, J, _offset = qubo_to_ising(Q)
    n_qubits = len(h)

    backend = AerSimulator(seed_simulator=seed)
    rng = np.random.default_rng(seed)

    def evaluate(params):
        qc = qaoa_circuit(h, J, params[:reps], params[reps:])
        tqc = transpile(qc, backend)
        result = backend.run(tqc, shots=shots // 4 or 1, seed_simulator=seed).result()
        counts = result.get_counts()
        return expected_objective(counts, Q, sum(counts.values()), n_items, n_slack)

    x0 = rng.uniform(0, np.pi, size=2 * reps)
    opt = minimize(evaluate, x0, method="COBYLA", options={"maxiter": 60})

    final_qc = qaoa_circuit(h, J, opt.x[:reps], opt.x[reps:])
    final_tqc = transpile(final_qc, backend)
    final_result = backend.run(final_tqc, shots=shots, seed_simulator=seed).result()
    counts = final_result.get_counts()

    selected_ids, best_value, best_feasible = best_feasible_from_counts(counts, items, budget, n_items)

    print(json.dumps({
        "selectedIds": selected_ids,
        "objectiveValue": best_value,
        "feasible": best_feasible,
        "algorithm": "QAOA",
        "backend": "aer_simulator",
        "qubits": n_qubits,
        "slackQubits": n_slack,
        "shots": shots,
        "reps": reps,
        "circuitDepth": final_tqc.depth(),
        "seed": seed,
        "qiskitVersion": qiskit.__version__,
        "qiskitAerVersion": qiskit_aer.__version__,
        "optimizerIterations": int(opt.nfev),
    }))


if __name__ == "__main__":
    main()
