"""
Shared QUBO/Ising/QAOA-circuit construction for BCI's quantum optimization
scripts (optimize_knapsack_qaoa.py: local simulator; ibm_backend.py: real
IBM hardware). Kept in one place so the local-simulator and IBM code paths
solve the mathematically identical problem -- any difference in results is
attributable to the backend, not to two different problem encodings.
"""
import math

import numpy as np
from qiskit import QuantumCircuit


def build_qubo(items, budget):
    n_items = len(items)
    n_slack = max(1, math.ceil(math.log2(budget + 1))) if budget > 0 else 1
    n = n_items + n_slack

    Q = np.zeros((n, n))
    values = [it["value"] for it in items]
    costs = [it["cost"] for it in items]
    max_value = max(values) if values else 1.0
    penalty = 4.0 * sum(abs(v) for v in values) + 4.0 * max_value + 10.0

    for i in range(n_items):
        Q[i, i] += -values[i]

    coeffs = list(costs) + [2 ** k for k in range(n_slack)]
    for i in range(n):
        Q[i, i] += penalty * (coeffs[i] ** 2 - 2 * budget * coeffs[i])
        for j in range(i + 1, n):
            Q[i, j] += 2 * penalty * coeffs[i] * coeffs[j]

    return Q, n_items, n_slack, coeffs


def qubo_to_ising(Q):
    """x_i = (1 - z_i) / 2, z_i in {-1, +1}. Returns (h, J, offset)."""
    n = Q.shape[0]
    h = np.zeros(n)
    J = np.zeros((n, n))
    offset = 0.0
    for i in range(n):
        offset += Q[i, i] / 2
        h[i] -= Q[i, i] / 2
        for j in range(i + 1, n):
            offset += Q[i, j] / 4
            h[i] -= Q[i, j] / 4
            h[j] -= Q[i, j] / 4
            J[i, j] += Q[i, j] / 4
    return h, J, offset


def qaoa_circuit(h, J, gammas, betas, measure=True):
    n = len(h)
    qc = QuantumCircuit(n)
    qc.h(range(n))
    for gamma, beta in zip(gammas, betas):
        for i in range(n):
            if abs(h[i]) > 1e-12:
                qc.rz(2 * gamma * h[i], i)
        for i in range(n):
            for j in range(i + 1, n):
                if abs(J[i, j]) > 1e-12:
                    qc.rzz(2 * gamma * J[i, j], i, j)
        for i in range(n):
            qc.rx(2 * beta, i)
    if measure:
        qc.measure_all()
    return qc


def best_feasible_from_counts(counts, items, budget, n_items):
    candidates = []
    for bits, count in counts.items():
        x = [int(b) for b in bits[::-1]]
        x_items = x[:n_items]
        total_cost = sum(c * xi for c, xi in zip([it["cost"] for it in items], x_items))
        value = sum(v * xi for v, xi in zip([it["value"] for it in items], x_items))
        candidates.append({"bits": bits, "count": count, "feasible": total_cost <= budget, "value": value, "x_items": x_items})

    feasible_candidates = [c for c in candidates if c["feasible"]]
    pool = feasible_candidates if feasible_candidates else candidates
    best = max(pool, key=lambda c: (c["feasible"], c["value"]))
    selected_ids = [items[i]["id"] for i in range(n_items) if best["x_items"][i] == 1]
    return selected_ids, best["value"], best["feasible"]
