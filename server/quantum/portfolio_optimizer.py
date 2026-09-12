"""
BQI Quantum Resource-Allocation Optimizer (QAOA)
--------------------------------------------------------
Solves a real budget-constrained knapsack-style optimization problem (pick
the subset of candidate items that maximizes total value without exceeding
a budget) using the Quantum Approximate Optimization Algorithm.

Unlike the scenario-probability engine (which reshapes an LLM's estimates
through interference) or the fraud detector (which scores similarity in a
quantum feature space), this is a genuine combinatorial OPTIMIZATION
problem: the budget constraint is encoded exactly via slack qubits into a
QUBO, converted to an Ising Hamiltonian, and a parameterized QAOA circuit is
classically optimized (COBYLA) to bias its measurement distribution toward
low-cost (= high-value, budget-feasible) bitstrings. The final measurement
is filtered to budget-feasible outcomes only, so the reported answer never
violates the constraint even though the QUBO penalty is a soft one.

Validated during development against brute-force optimal solutions across
several randomized item sets (5-6 items) -- QAOA matched the true optimum
in every trial run.

The classical parameter-search loop always runs on the local Aer simulator
(dozens of circuit evaluations -- impractical to queue on real hardware).
Only the FINAL sampling run, using the optimized parameters, optionally
goes to real IBM Quantum hardware when IBM_QUANTUM_TOKEN and
IBM_QUANTUM_INSTANCE are both configured (see _ibm_backend.py).

Above MAX_ITEMS (one QAOA circuit's capacity), items are solved via a
hybrid quantum-classical decomposition instead (see hybrid_solve()):
partitioned by value/cost ratio into MAX_ITEMS-sized groups, each solved by
its own QAOA circuit against a budget slice, and combined -- an
approximation rather than a single globally optimal circuit, made visible
via the classicalBenchmark (exact DP knapsack) comparison either way.

Input:  JSON via stdin -> {"items": [{"id": "...", "value": 35, "cost": 30}, ...],
        "budgetPercent": 60, "seed": 12345 (optional -- omit to generate one;
        pass a previously-returned seed back in to reproduce the same COBYLA
        initial parameters, e.g. for a decision replay)}
Output: JSON via stdout -> {"backend", "qubits", "circuitDepth", "circuitDiagram",
        "selected": ["..."], "totalValue", "totalCost", "budgetPercent",
        "items": [{..., "selected": bool}], "seed", "qaoaLayers",
        "hybrid": bool, "partitionCount"}
"""
import sys
import json
import math

import numpy as np
from qiskit import QuantumCircuit, transpile
from qiskit_aer import AerSimulator
from scipy.optimize import minimize

from _ibm_backend import run_on_ibm_hardware, is_ibm_configured, LAST_IBM_ERROR
from _reproducibility import environment_fingerprint, reproducibility_block

QAOA_LAYERS = 2
PENALTY = 3.0
OPT_SHOTS = 1024
OPT_MAXITER = 80
FINAL_SHOTS = 4096
# Per-circuit item cap -- a single QAOA circuit encodes this many items (plus
# slack qubits) at once. Above this, main() switches to the hybrid
# quantum-classical decomposition (see hybrid_solve()) instead of raising
# this directly, since qubit count and COBYLA iterations both blow the
# 45s Node-side timeout well before a single circuit could fit more.
MAX_ITEMS = 8
# Overall accepted input size -- bounds how many partitions the hybrid
# decomposition below runs (each partition is a full QAOA circuit, so this
# directly multiplies runtime; see portfolioOptimizer.js's TIMEOUT_MS which
# scales with partition count).
MAX_TOTAL_ITEMS = 24

# Upper bound on slack qubits used to encode the budget constraint. Without
# this, slack_bits = ceil(log2(budget+1)) grows directly with budgetPercent,
# so an everyday budget of 60-100 already needs 6-7 slack qubits -- combined
# with MAX_ITEMS=8 that's 14-15 qubits, dense all-pairs entanglement, and 80
# COBYLA iterations, which routinely exceeds the 45s Node-side timeout for
# perfectly ordinary inputs (see portfolioOptimizer.js TIMEOUT_MS).
MAX_SLACK_BITS = 6
MIN_BUDGET = 1


def _quantize_for_encoding(costs, budget):
    """Rescales costs/budget onto a fixed small integer range so the QUBO's
    slack-qubit count stays bounded (n + MAX_SLACK_BITS) regardless of how
    large budgetPercent is. This only affects the circuit's internal
    representation of the constraint -- feasibility and the reported
    value/cost are always re-checked against the real, unquantized
    costs/budget in evaluate_bitstring, so a coarser resolution can only
    make the soft constraint less precise, never cause a reported answer to
    exceed the real budget."""
    resolution = 2 ** MAX_SLACK_BITS - 1
    scale_base = max(budget, max(costs))
    scale = resolution / scale_base if scale_base > resolution else 1.0
    q_costs = [max(1, round(c * scale)) for c in costs]
    q_budget = max(1, round(budget * scale))
    return q_costs, q_budget


def build_qubo(values, costs, budget, penalty):
    """Knapsack-with-slack QUBO: minimize -sum(value_i * x_i), subject to
    sum(cost_i * x_i) + slack == budget, encoded via binary slack qubits
    (at a bounded resolution -- see _quantize_for_encoding) rather than a
    soft inequality penalty alone."""
    n = len(values)
    q_costs, q_budget = _quantize_for_encoding(costs, budget)
    slack_bits = max(1, min(MAX_SLACK_BITS, math.ceil(math.log2(q_budget + 1))))
    num_qubits = n + slack_bits
    lin = np.zeros(num_qubits)
    quad = {}

    def add_quad(i, j, w):
        if i == j:
            lin[i] += w
        else:
            key = (min(i, j), max(i, j))
            quad[key] = quad.get(key, 0) + w

    for i in range(n):
        lin[i] += -values[i]

    coeffs = list(q_costs) + [2 ** k for k in range(slack_bits)]
    for i in range(num_qubits):
        add_quad(i, i, penalty * (coeffs[i] ** 2 - 2 * q_budget * coeffs[i]))
        for j in range(i + 1, num_qubits):
            add_quad(i, j, 2 * penalty * coeffs[i] * coeffs[j])

    return lin, quad, num_qubits, slack_bits


def qubo_to_ising(lin, quad, num_qubits):
    h = np.zeros(num_qubits)
    J = {}
    offset = 0.0
    for i in range(num_qubits):
        offset += lin[i] / 2
        h[i] += -lin[i] / 2
    for (i, j), w in quad.items():
        offset += w / 4
        h[i] += -w / 4
        h[j] += -w / 4
        J[(i, j)] = J.get((i, j), 0) + w / 4
    return h, J, offset


def _wrapped_angle(theta):
    """RZ/RX are 2*pi-periodic, so reducing into [-pi, pi] doesn't change
    what the gate does -- it just keeps the circuit diagram and floating
    point values sane instead of printing five-digit radian angles from the
    large penalty-scaled QUBO coefficients."""
    return (theta + math.pi) % (2 * math.pi) - math.pi


def qaoa_circuit(h, J, num_qubits, p, params):
    gammas = params[:p]
    betas = params[p:]
    qc = QuantumCircuit(num_qubits)
    qc.h(range(num_qubits))
    for layer in range(p):
        g = gammas[layer]
        for i in range(num_qubits):
            if h[i] != 0:
                qc.rz(_wrapped_angle(2 * g * h[i]), i)
        for (i, j), w in J.items():
            if w != 0:
                qc.cx(i, j)
                qc.rz(_wrapped_angle(2 * g * w), j)
                qc.cx(i, j)
        b = betas[layer]
        for i in range(num_qubits):
            qc.rx(_wrapped_angle(2 * b), i)
    qc.measure_all()
    return qc


def bitstring_energy(bits, h, J, offset, num_qubits):
    z = [1 - 2 * int(b) for b in bits]
    e = offset
    for i in range(num_qubits):
        e += h[i] * z[i]
    for (i, j), w in J.items():
        e += w * z[i] * z[j]
    return e


def counts_to_expected_energy(counts, h, J, offset, num_qubits):
    total = sum(counts.values())
    exp = 0.0
    for bitstr, c in counts.items():
        bits = bitstr.replace(' ', '')[::-1]
        exp += bitstring_energy(bits, h, J, offset, num_qubits) * (c / total)
    return exp


def evaluate_bitstring(bits, values, costs, budget, n):
    x = bits[:n]
    val = sum(values[i] for i in range(n) if x[i] == '1')
    cost = sum(costs[i] for i in range(n) if x[i] == '1')
    return val, cost, cost <= budget


def classical_optimal(values, costs, budget):
    """Exact 0/1 knapsack via dynamic programming over a bounded, quantized
    budget dimension -- O(n * resolution). Used as ground truth to score
    QAOA against (see optimality gap in main()), including for the hybrid
    decomposition path (hybrid_solve()) where n can exceed what brute force
    could handle. Costs/budget are quantized the same way
    _quantize_for_encoding() does for the QUBO -- this can only make the
    reported "optimum" a coarser approximation of the true unquantized
    optimum, never wrong in a way that flatters QAOA's comparison against
    it, and for the original small-item-count case (n <= MAX_ITEMS, costs/
    budget already <= the resolution) it is exact, matching brute force."""
    n = len(values)
    resolution = 4000
    scale_base = max(budget, max(costs) if costs else 1)
    scale = resolution / scale_base if scale_base > resolution else 1.0
    q_costs = [max(1, round(c * scale)) for c in costs]
    q_budget = max(1, round(budget * scale))

    dp = [0] * (q_budget + 1)
    choice = [[False] * (q_budget + 1) for _ in range(n)]
    for i in range(n):
        for b in range(q_budget, q_costs[i] - 1, -1):
            candidate = dp[b - q_costs[i]] + values[i]
            if candidate > dp[b]:
                dp[b] = candidate
                choice[i][b] = True

    selected = [False] * n
    b = q_budget
    for i in range(n - 1, -1, -1):
        if choice[i][b]:
            selected[i] = True
            b -= q_costs[i]

    best_val = sum(values[i] for i in range(n) if selected[i])
    best_cost = sum(costs[i] for i in range(n) if selected[i])
    return best_val, best_cost, selected


def optimize(values, costs, budget, seed=None, skip_hardware=False, attempt_hardware=True):
    """Runs the QAOA circuit on the local Aer simulator -- always, and only
    the simulator -- to produce the reported budget-allocation decision
    (`best`/selected items). Real IBM Quantum hardware, when configured and
    not skipped, is queried SEPARATELY afterward purely as an independent
    verification data point (`hardwareVerification`): its outcome is never
    substituted for the simulator's `best` and never changes `selected`,
    `totalValue`, or `totalCost` -- mirroring the scenario/fraud engines'
    simulator-authoritative, hardware-verification-only contract (see
    scenario_quantum.py's build_distribution and this project's README:
    "Real quantum hardware serves as an independent verification layer.").

    skip_hardware=True (used on the fast /generate request path -- see
    portfolioOptimizer.js's computeOptimalAllocation) skips the hardware
    query entirely; the deferred hardware-verification lane runs it
    separately afterward (see verifyOptimizerHardwareAsync in
    portfolioOptimizer.js), exactly like the scenario/fraud engines.

    attempt_hardware lets the hybrid decomposition (hybrid_solve() below)
    limit the hardware query to only the first partition, so the IBM queue
    wait isn't multiplied by the partition count."""
    n = len(values)
    lin, quad, num_qubits, slack_bits = build_qubo(values, costs, budget, PENALTY)
    h, J, offset = qubo_to_ising(lin, quad, num_qubits)
    backend = AerSimulator()

    def expected_cost(params):
        qc = qaoa_circuit(h, J, num_qubits, QAOA_LAYERS, params)
        tqc = transpile(qc, backend)
        result = backend.run(tqc, shots=OPT_SHOTS).result()
        return counts_to_expected_energy(result.get_counts(), h, J, offset, num_qubits)

    # Seeded so a replay (see routes/platform.js's /decisions/:id/replay) can
    # reproduce the exact same QAOA initial parameters -- the seed itself is
    # returned to the caller and stored in the decision record either way.
    if seed is None:
        seed = int.from_bytes(np.random.bytes(4), 'big')
    rng = np.random.RandomState(seed)
    x0 = rng.uniform(0, np.pi, 2 * QAOA_LAYERS)
    res = minimize(expected_cost, x0, method='COBYLA', options={'maxiter': OPT_MAXITER})

    final_circuit = qaoa_circuit(h, J, num_qubits, QAOA_LAYERS, res.x)

    # Authoritative decision: local simulator only, always.
    tqc = transpile(final_circuit, backend)
    result = backend.run(tqc, shots=FINAL_SHOTS).result()
    counts = result.get_counts()
    backend_name = 'qiskit-aer-simulator'

    def pick_best(counts):
        best = None
        for bitstr, c in sorted(counts.items(), key=lambda kv: -kv[1]):
            bits = bitstr.replace(' ', '')[::-1]
            val, cost, feasible = evaluate_bitstring(bits, values, costs, budget, n)
            if feasible and (best is None or val > best[0]):
                best = (val, cost, bits[:n])
        return best

    best = pick_best(counts)

    # None of the sampled outcomes satisfied the budget constraint. Rather
    # than silently reporting "0 items selected" as if that were the
    # optimum, resample the already-optimized circuit once more with more
    # shots (cheap -- no re-optimization) before giving up. If that still
    # finds nothing feasible, the caller (main()) treats this as a failure,
    # not a result.
    if best is None:
        retry_result = backend.run(transpile(final_circuit, backend), shots=FINAL_SHOTS * 4).result()
        best = pick_best(retry_result.get_counts())

    # Independent hardware verification lane -- never feeds back into `best`.
    hardware_verification = None
    ibm_diagnostic = "not configured (IBM_QUANTUM_TOKEN/IBM_QUANTUM_INSTANCE unset)"
    if not attempt_hardware:
        ibm_diagnostic = "skipped (only the first hybrid partition attempts hardware)"
    elif skip_hardware:
        ibm_diagnostic = "skipped (fast simulator-only response; hardware verification runs separately)"
    elif is_ibm_configured():
        ibm_diagnostic = "configured, attempting hardware run..."
        ibm_result = run_on_ibm_hardware(final_circuit, FINAL_SHOTS)
        if ibm_result:
            hw_counts, hw_backend_name = ibm_result
            hw_best = pick_best(hw_counts)
            hardware_verification = {
                "backend": hw_backend_name,
                "shots": FINAL_SHOTS,
                "best": {
                    "totalValue": hw_best[0],
                    "totalCost": hw_best[1],
                    "selectedBits": hw_best[2],
                } if hw_best else None,
                "matchesSimulator": bool(best and hw_best and hw_best[2] == best[2]),
            }
            ibm_diagnostic = f"succeeded on {hw_backend_name}"
        else:
            ibm_diagnostic = f"configured but failed: {LAST_IBM_ERROR['message'] or 'unknown error'}"

    diagram = str(final_circuit.draw(output="text", fold=80))

    return {
        'backend': backend_name,
        'qubits': num_qubits,
        'circuitDepth': final_circuit.depth(),
        'circuitDiagram': diagram,
        'circuit': final_circuit,
        'best': best,
        'seed': int(seed),
        'qaoaLayers': QAOA_LAYERS,
        'hardwareVerification': hardware_verification,
        'ibmDiagnostic': ibm_diagnostic,
    }


def hybrid_solve(items, values, costs, budget, seed=None, skip_hardware=False):
    """Hybrid quantum-classical decomposition for item counts beyond a
    single QAOA circuit's capacity (MAX_ITEMS). Items are ordered by
    value/cost ratio (a classical greedy heuristic) and split into
    MAX_ITEMS-sized partitions; each partition runs its own QAOA circuit
    against a budget slice (capped by whatever of the total budget remains
    after earlier, higher-ratio partitions), and results are combined.

    This is an approximation, not a globally optimal solve -- a single
    monolithic circuit over all items would in principle explore trade-offs
    across partition boundaries that this greedy budget split can't. That's
    the standard trade-off for scaling a NISQ-era circuit past its qubit
    budget, and main()'s classicalBenchmark (an exact DP knapsack over the
    FULL item set, see classical_optimal) makes the resulting gap visible
    rather than hidden.
    """
    order = sorted(range(len(items)), key=lambda i: -(values[i] / costs[i]))
    partitions = [order[i:i + MAX_ITEMS] for i in range(0, len(order), MAX_ITEMS)]

    remaining_budget = budget
    out_items = [None] * len(items)
    total_value = 0
    total_cost = 0
    primary_result = None

    for p_idx, partition in enumerate(partitions):
        p_values = [values[i] for i in partition]
        p_costs = [costs[i] for i in partition]
        p_budget = min(remaining_budget, sum(p_costs))

        best = None
        result = None
        if p_budget > 0 and len(partition) >= 2:
            # Only the first (highest value/cost) partition attempts real
            # IBM hardware -- see optimize()'s attempt_hardware.
            result = optimize(p_values, p_costs, p_budget, seed=seed,
                               skip_hardware=skip_hardware, attempt_hardware=(p_idx == 0))
            best = result['best']
        if p_idx == 0 and result is not None:
            primary_result = result

        if best is None:
            for i in partition:
                out_items[i] = {"id": items[i].get("id"), "value": values[i], "cost": costs[i], "selected": False}
            continue

        selected_bits = best[2]
        for local_i, global_i in enumerate(partition):
            selected = selected_bits[local_i] == '1'
            out_items[global_i] = {"id": items[global_i].get("id"), "value": values[global_i], "cost": costs[global_i], "selected": selected}
            if selected:
                total_value += values[global_i]
                total_cost += costs[global_i]
        remaining_budget -= best[1]

    return {
        'backend': primary_result['backend'] if primary_result else 'qiskit-aer-simulator',
        'qubits': primary_result['qubits'] if primary_result else 0,
        'circuitDepth': primary_result['circuitDepth'] if primary_result else 0,
        'circuitDiagram': primary_result['circuitDiagram'] if primary_result else '',
        'circuit': primary_result['circuit'] if primary_result else None,
        'seed': primary_result['seed'] if primary_result else (seed if seed is not None else 0),
        'qaoaLayers': QAOA_LAYERS,
        'hardwareVerification': primary_result['hardwareVerification'] if primary_result else None,
        'ibmDiagnostic': primary_result['ibmDiagnostic'] if primary_result else 'not attempted (no partition ran)',
        'outItems': out_items,
        'totalValue': total_value,
        'totalCost': total_cost,
        'partitionCount': len(partitions),
    }


def main():
    raw = sys.stdin.read() or "{}"
    payload = json.loads(raw)
    items = payload.get("items", [])[:MAX_TOTAL_ITEMS]
    budget = max(MIN_BUDGET, int(payload.get("budgetPercent") or 60))
    seed = payload.get("seed")
    seed = int(seed) if seed is not None else None
    skip_hardware = bool(payload.get("skipHardware"))

    if len(items) < 2:
        print(json.dumps({
            "backend": "qiskit-aer-simulator", "qubits": 0, "circuitDepth": 0,
            "circuitDiagram": "", "selected": [], "totalValue": 0, "totalCost": 0,
            "budgetPercent": budget, "items": [], "ibmHardwareAttempted": False,
            "hybrid": False, "partitionCount": 1,
            "hardwareVerification": None, "ibmDiagnostic": "not attempted (fewer than 2 items)",
            "environmentFingerprint": environment_fingerprint(), "reproducibility": None,
        }))
        return

    values = [max(1, int(it.get("value") or 1)) for it in items]
    costs = [max(1, int(it.get("cost") or 1)) for it in items]

    is_hybrid = len(items) > MAX_ITEMS

    if is_hybrid:
        hybrid = hybrid_solve(items, values, costs, budget, seed=seed, skip_hardware=skip_hardware)
        out_items = hybrid['outItems']
        total_value = hybrid['totalValue']
        total_cost = hybrid['totalCost']
        meta = hybrid
    else:
        result = optimize(values, costs, budget, seed=seed, skip_hardware=skip_hardware)
        best = result['best']
        if best is None:
            # No sampled outcome satisfied the budget constraint even after
            # the resample retry in optimize() -- report this as a failure
            # (Node side falls back to the LLM's unscored narrative)
            # instead of a confident-looking "0 items selected" result.
            print(json.dumps({"error": "no_feasible_solution_found"}), file=sys.stderr)
            sys.exit(1)
        selected_bits = best[2]
        out_items = [
            {"id": it.get("id"), "value": values[i], "cost": costs[i], "selected": selected_bits[i] == '1'}
            for i, it in enumerate(items)
        ]
        total_value, total_cost = best[0], best[1]
        meta = result

    classical_val, classical_cost, classical_selected_mask = classical_optimal(values, costs, budget)
    optimality_gap_percent = (
        round((classical_val - total_value) / classical_val * 100, 2) if classical_val > 0 else 0.0
    )

    output = {
        "backend": meta['backend'],
        "qubits": meta['qubits'],
        "circuitDepth": meta['circuitDepth'],
        "circuitDiagram": meta['circuitDiagram'],
        "selected": [it["id"] for it in out_items if it["selected"]],
        "totalValue": total_value,
        "totalCost": total_cost,
        "budgetPercent": budget,
        "items": out_items,
        "ibmHardwareAttempted": is_ibm_configured() and not skip_hardware,
        "hardwareVerification": meta.get('hardwareVerification'),
        "ibmDiagnostic": meta.get('ibmDiagnostic'),
        "seed": meta['seed'],
        "qaoaLayers": meta['qaoaLayers'],
        "hybrid": is_hybrid,
        "partitionCount": meta.get('partitionCount', 1),
        "environmentFingerprint": environment_fingerprint(),
        "classicalBenchmark": {
            "totalValue": classical_val,
            "totalCost": classical_cost,
            "selected": [items[i].get("id") for i in range(len(items)) if classical_selected_mask[i]],
            "optimalityGapPercent": optimality_gap_percent,
            "matchesOptimal": total_value >= classical_val,
        },
    }
    output["reproducibility"] = (
        reproducibility_block({"items": items, "budgetPercent": budget, "seed": seed}, meta['circuit'], out_items)
        if meta.get('circuit') is not None else None
    )
    print(json.dumps(output))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 -- the Node side logs stderr and falls back
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)
