"""
CI smoke test for the three Qiskit worker scripts.

py_compile (see ci.yml) only proves the files parse -- it can't catch a
broken import, an API that changed between Qiskit versions, or a genuine
logic error (e.g. probabilities that don't sum to ~100%). This actually
runs each worker's stdin/stdout contract against a small, fixed input and
sanity-checks the shape and a few invariants of the result, the way a real
request would exercise it -- without needing a live IBM Quantum account
(each call passes skipHardware/omits IBM credentials, so this only exercises
the local Aer simulator path).

Run directly: python3 quantum/smoke_test.py
"""
import json
import subprocess
import sys
from pathlib import Path

QUANTUM_DIR = Path(__file__).parent


def run_worker(script, payload):
    proc = subprocess.run(
        [sys.executable, str(QUANTUM_DIR / script)],
        input=json.dumps(payload),
        capture_output=True, text=True, timeout=60,
    )
    if proc.returncode != 0:
        raise AssertionError(f"{script} exited {proc.returncode}\nstderr: {proc.stderr}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise AssertionError(f"{script} did not print valid JSON on stdout\nstdout: {proc.stdout}\nstderr: {proc.stderr}") from exc


def check_scenario_quantum():
    result = run_worker("scenario_quantum.py", {
        "shots": 512,
        "scenarios": [{"id": "A", "weight": 0.4}, {"id": "B", "weight": 0.35}, {"id": "C", "weight": 0.25}],
    })
    assert result["backend"] == "qiskit-aer-simulator", result
    assert result["qubits"] > 0, result
    assert len(result["scenarios"]) == 3, result
    total = sum(s["quantumProbability"] for s in result["scenarios"])
    assert 95 <= total <= 105, f"scenario probabilities should sum to ~100%, got {total}"
    assert "environmentFingerprint" in result and result["environmentFingerprint"]["qiskitVersion"], result
    assert result["reproducibility"]["inputHash"] and result["reproducibility"]["circuitHash"], result
    print("[smoke] scenario_quantum.py OK")


def check_fraud_detection():
    transactions = [
        {"id": f"T{i}", "amount": 1000 + i * 500, "hour": i % 24, "frequency": 1, "newCounterparty": i % 2, "crossBorder": 0}
        for i in range(6)
    ]
    result = run_worker("fraud_detection.py", {"transactions": transactions})
    assert result["backend"] == "qiskit-statevector-kernel", result
    assert len(result["transactions"]) == len(transactions), result
    assert all("riskScore" in t and "flagged" in t for t in result["transactions"]), result
    assert result["environmentFingerprint"]["qiskitVersion"], result
    assert result["reproducibility"]["inputHash"] and result["reproducibility"]["circuitHash"], result
    print("[smoke] fraud_detection.py OK")


def check_fraud_detection_13q():
    """fraud_detection_13q.py is the script actually spawned in production
    (see server/src/services/fraudDetection.js) -- unlike fraud_detection.py
    above, this one previously had no smoke coverage at all."""
    transactions = [
        {
            "id": f"T{i}", "amount": 1000 + i * 500, "hour": i % 24, "frequency": 1,
            "newCounterparty": i % 2, "crossBorder": 0, "txCount10m": i % 3, "txCount1h": i % 5,
            "amountSum1h": 2000 + i * 300, "amountSum24h": 5000 + i * 700, "timeSinceLastTx": 600 + i * 60,
            "newCounterpartyCount24h": i % 4, "uniqueCounterparty7d": i % 6, "amountDeviation": (i % 3) - 1,
        }
        for i in range(6)
    ]
    result = run_worker("fraud_detection_13q.py", {"transactions": transactions})
    assert result["backend"] == "qiskit-statevector-kernel-13q", result
    assert len(result["transactions"]) == len(transactions), result
    assert all("riskScore" in t and "flagged" in t for t in result["transactions"]), result
    # No IBM credentials in this CI environment -- must report "not
    # configured", never silently substitute hardware noise for the
    # deterministic statevector-kernel decision above.
    assert result["hardwareVerification"] is None, result
    assert "not configured" in result["ibmDiagnostic"], result
    print("[smoke] fraud_detection_13q.py OK")


def check_fraud_detection_13q_skip_hardware():
    """Regression test for BQI-010: skipHardware=True (the fast /generate
    request path, see fraudDetection.js's computeFraudRiskScores) must
    report the hardware lane as explicitly skipped, never attempted."""
    transactions = [
        {
            "id": f"T{i}", "amount": 1000 + i * 500, "hour": i % 24, "frequency": 1,
            "newCounterparty": i % 2, "crossBorder": 0, "txCount10m": i % 3, "txCount1h": i % 5,
            "amountSum1h": 2000 + i * 300, "amountSum24h": 5000 + i * 700, "timeSinceLastTx": 600 + i * 60,
            "newCounterpartyCount24h": i % 4, "uniqueCounterparty7d": i % 6, "amountDeviation": (i % 3) - 1,
        }
        for i in range(6)
    ]
    result = run_worker("fraud_detection_13q.py", {"transactions": transactions, "skipHardware": True})
    assert result["hardwareVerification"] is None, result
    assert "skipped" in result["ibmDiagnostic"], result
    print("[smoke] fraud_detection_13q.py skipHardware OK")


def check_portfolio_optimizer():
    items = [
        {"id": "I1", "value": 40, "cost": 30}, {"id": "I2", "value": 35, "cost": 25},
        {"id": "I3", "value": 20, "cost": 15}, {"id": "I4", "value": 25, "cost": 20},
    ]
    budget = 60
    result = run_worker("portfolio_optimizer.py", {"items": items, "budgetPercent": budget})
    assert result["backend"] == "qiskit-aer-simulator", result
    # despite the field's name, the worker treats "budgetPercent" as an absolute
    # budget value (see portfolio_optimizer.py's main()), not a percentage of
    # total item cost -- the only hard constraint is totalCost <= budget.
    assert result["totalCost"] <= budget, result
    assert result["classicalBenchmark"]["totalValue"] >= result["totalValue"], (
        "the classical exact optimum must never score lower than QAOA's result", result
    )
    assert result["environmentFingerprint"]["qiskitVersion"], result
    assert result["reproducibility"]["inputHash"] and result["reproducibility"]["circuitHash"], result
    # No IBM credentials in this CI environment -- the reported selection
    # must always come from the simulator (`backend` above), and hardware
    # verification must be reported as merely "not configured", never
    # silently substituted for the decision itself. See optimize()'s
    # docstring in portfolio_optimizer.py.
    assert result["hardwareVerification"] is None, result
    assert "not configured" in result["ibmDiagnostic"], result
    print("[smoke] portfolio_optimizer.py OK")


def check_portfolio_optimizer_skip_hardware_never_attempts():
    """Regression test for BQI-006/BQI-011: skipHardware=True (the fast
    /generate request path, see portfolioOptimizer.js's computeOptimalAllocation)
    must report the hardware lane as explicitly skipped, never attempted --
    the simulator selection must never be affected either way."""
    items = [{"id": "I1", "value": 40, "cost": 30}, {"id": "I2", "value": 35, "cost": 25}]
    result = run_worker("portfolio_optimizer.py", {"items": items, "budgetPercent": 60, "skipHardware": True})
    assert result["ibmHardwareAttempted"] is False, result
    assert result["hardwareVerification"] is None, result
    assert "skipped" in result["ibmDiagnostic"], result
    print("[smoke] portfolio_optimizer.py skipHardware OK")


if __name__ == "__main__":
    check_scenario_quantum()
    check_fraud_detection()
    check_fraud_detection_13q()
    check_fraud_detection_13q_skip_hardware()
    check_portfolio_optimizer()
    check_portfolio_optimizer_skip_hardware_never_attempts()
    print("[smoke] all quantum workers OK")
