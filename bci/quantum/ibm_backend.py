#!/usr/bin/env python3
"""
BCI IBM Quantum Compute Adapter -- submits the same knapsack QUBO
(see _qubo.py / optimize_knapsack_qaoa.py) to real IBM Quantum hardware via
qiskit-ibm-runtime.

Modernized against the CURRENT IBM Quantum Platform API (qiskit-ibm-runtime
0.49, checked against the installed package at development time -- see
bci/quantum/requirements.txt): QiskitRuntimeService with the
"ibm_quantum_platform" channel (the unified platform channel IBM migrated
to; the legacy "ibm_quantum" channel BQI's own, older
_ibm_backend.py predates this migration and is left untouched -- see
bci/ENTERPRISE.md and the BCI README for why BCI's quantum stack is
intentionally independent) and the SamplerV2 primitive.

NOT independently verified against a real IBM Quantum account during
development -- no IBM Quantum API token was available in that environment.
This script is structurally correct against the installed SDK's current
API surface, but its live-hardware path is UNTESTED. Treat it as
EXPERIMENTAL until run once against a real account (spec section 28's
IMPLEMENTED/EXPERIMENTAL/PLANNED/DISABLED distinction).

Reads the same stdin JSON shape as optimize_knapsack_qaoa.py, plus:
  { ..., "token": str, "instance": str (optional), "backendName": str (optional) }
Credentials arrive via stdin from the Node adapter (which itself only ever
reads them from an env var, never a database) -- never logged, never
included in the JSON written back to stdout.
"""
import sys
import json

import numpy as np
from scipy.optimize import minimize

import qiskit
from qiskit import transpile
from qiskit_ibm_runtime import QiskitRuntimeService, SamplerV2

from _qubo import build_qubo, qubo_to_ising, qaoa_circuit, best_feasible_from_counts


def redact_secret(text, secret):
    """Defense in depth: never trust an upstream SDK's exception message not
    to echo back a credential it was just handed (e.g. an "invalid token:
    <token>" style auth error). Applied to every exception string before it
    is written to stdout, regardless of whether qiskit_ibm_runtime is known
    to do this today -- a secret must never depend on a third-party
    library's error-formatting behavior staying the same across versions."""
    if not text or not secret:
        return text
    return text.replace(secret, "[REDACTED]")


def main():
    payload = json.loads(sys.stdin.read())
    items = payload["items"]
    budget = int(payload["budget"])
    reps = int(payload.get("reps", 1))  # fewer reps than the simulator: real hardware time is expensive/queued
    shots = int(payload.get("shots", 1024))
    seed = payload.get("seed", 42)
    token = payload.get("token")
    instance = payload.get("instance")
    backend_name = payload.get("backendName")

    if not token:
        print(json.dumps({"error": "no IBM Quantum token provided"}))
        return

    Q, n_items, n_slack, _coeffs = build_qubo(items, budget)
    h, J, _offset = qubo_to_ising(Q)
    n_qubits = len(h)

    try:
        service = QiskitRuntimeService(channel="ibm_quantum_platform", token=token, instance=instance)
        backend = service.backend(backend_name) if backend_name else service.least_busy(operational=True, min_num_qubits=n_qubits)
    except Exception as exc:  # noqa: BLE001 -- any auth/network/availability failure is reported, never silently swallowed
        print(json.dumps({"error": redact_secret(f"IBM Quantum connection failed: {exc}", token)}))
        return

    rng = np.random.default_rng(seed)
    # A single fixed angle set (no classical outer optimization loop against
    # real hardware): every additional iteration is a real, queued, billed
    # hardware job. This is a deliberate cost guard (spec section 26), not
    # an oversight -- production tuning of QAOA angles belongs on the free
    # local simulator (optimize_knapsack_qaoa.py), not on paid QPU time.
    gammas = rng.uniform(0, np.pi, size=reps)
    betas = rng.uniform(0, np.pi, size=reps)
    qc = qaoa_circuit(h, J, gammas, betas)

    try:
        tqc = transpile(qc, backend)
        sampler = SamplerV2(mode=backend)
        job = sampler.run([tqc], shots=shots)
        result = job.result()
        counts = result[0].data.meas.get_counts()
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": redact_secret(f"IBM Quantum job failed: {exc}", token)}))
        return

    selected_ids, best_value, best_feasible = best_feasible_from_counts(counts, items, budget, n_items)

    print(json.dumps({
        "selectedIds": selected_ids,
        "objectiveValue": best_value,
        "feasible": best_feasible,
        "algorithm": "QAOA",
        "backend": backend.name,
        "hardware": True,
        "qubits": n_qubits,
        "shots": shots,
        "reps": reps,
        "circuitDepth": tqc.depth(),
        "seed": seed,
        "qiskitVersion": qiskit.__version__,
        "jobId": job.job_id(),
    }))


if __name__ == "__main__":
    main()
