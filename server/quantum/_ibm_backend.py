"""
Shared helper for optionally running a circuit's final measurement on real
IBM Quantum hardware instead of the local Aer simulator, when both
IBM_QUANTUM_TOKEN and IBM_QUANTUM_INSTANCE are configured. Falls back to the
local simulator on any failure (missing credentials, package missing,
network error, no available backend, queue timeout) -- this mirrors the
graceful-fallback pattern used for Redis/S3 elsewhere in this project (see
server/src/lib/redis.ts, server/src/lib/objectStorage.ts).

IBM retired the classic "ibm_quantum" channel/account model (the one tied to
a bare API token at quantum.ibm.com) on July 1 -- the current IBM Quantum
Platform is an IBM Cloud service. Authenticating now requires an IBM Cloud
API key (still called a "token" here) *and* the Cloud Resource Name (CRN) of
a Qiskit Runtime service instance provisioned in that IBM Cloud account,
passed as `instance`. See README.md's Optional Infrastructure table for how
to obtain both.

LIVE VALIDATION: this integration has been exercised against a real IBM
Quantum Platform account. Authentication, Qiskit Runtime service connection,
least-busy real-backend selection, transpilation, hardware job submission,
and hardware-result retrieval have been validated through the production
integration path. The local deterministic simulator remains the authoritative
decision path; IBM hardware is intentionally used as an independent
verification lane so NISQ hardware noise cannot alter a reported decision.
"""
import os
import sys
import time

IBM_TOKEN = os.environ.get("IBM_QUANTUM_TOKEN")
IBM_INSTANCE = os.environ.get("IBM_QUANTUM_INSTANCE")
IBM_WAIT_SECONDS = int(os.environ.get("IBM_QUANTUM_WAIT_SECONDS", "60"))

# Diagnostic-only: the reason the last run_on_ibm_hardware() call fell back
# to the simulator, so the quantum-status health check can surface *why*
# (instead of run_on_ibm_hardware()'s None being indistinguishable from
# "not configured" once it crosses back into Node/the HTTP response).
LAST_IBM_ERROR = {"message": None}


def is_ibm_configured():
    return bool(IBM_TOKEN and IBM_INSTANCE)


def _redact(text):
    """Strips the configured IBM token/instance CRN out of diagnostic text
    before it's cached in LAST_IBM_ERROR -- that message is surfaced back
    through Node's ibmDiagnostic to the client, and some qiskit-ibm-runtime
    SDK exceptions embed the credentials they failed to authenticate with
    verbatim in their message."""
    if IBM_TOKEN:
        text = text.replace(IBM_TOKEN, "***REDACTED***")
    if IBM_INSTANCE:
        text = text.replace(IBM_INSTANCE, "***REDACTED***")
    return text


def run_on_ibm_hardware(circuit, shots):
    """Attempts to run `circuit` on the least-busy real IBM backend, waiting
    up to IBM_WAIT_SECONDS for the job to finish. Returns (counts, backend_name)
    on success, or None on any failure/timeout -- the caller should then run
    the same circuit on AerSimulator instead."""
    if not is_ibm_configured():
        return None
    try:
        from qiskit import transpile
        from qiskit_ibm_runtime import QiskitRuntimeService, SamplerV2

        service = QiskitRuntimeService(channel="ibm_quantum_platform", token=IBM_TOKEN, instance=IBM_INSTANCE)
        backend = service.least_busy(operational=True, simulator=False)
        # translation_method="translator" sidesteps a known qiskit/
        # qiskit-ibm-runtime plugin-resolution bug where transpile() picks
        # the "ibm_dynamic_circuits" translation plugin for some IBM
        # backends even though this circuit has no dynamic-circuit
        # (mid-circuit measurement + classical feedforward) features that
        # would need it, and that plugin then fails to resolve
        # ("Invalid plugin name ibm_dynamic_circuits for stage translation").
        # See https://github.com/Qiskit/qiskit-ibm-runtime/issues/738 and
        # https://github.com/Qiskit/qiskit-ibm-runtime/issues/1253.
        transpiled = transpile(circuit, backend=backend, optimization_level=1, translation_method="translator")

        sampler = SamplerV2(mode=backend)
        job = sampler.run([transpiled], shots=shots)

        deadline = time.time() + IBM_WAIT_SECONDS
        status = job.status()
        while status not in ("DONE", "ERROR", "CANCELLED") and time.time() < deadline:
            time.sleep(2)
            status = job.status()

        if status != "DONE":
            print(f"[quantum] IBM hardware job did not finish in time (status={status}), falling back to simulator", file=sys.stderr)
            LAST_IBM_ERROR["message"] = f"job status was {status!r} after waiting {IBM_WAIT_SECONDS}s (queue too long, or the job errored/was cancelled)"
            return None

        result = job.result()
        pub_result = result[0]
        counts = pub_result.data.meas.get_counts()
        return counts, backend.name
    except Exception as exc:
        # A persistent misconfiguration (bad token/CRN, expired credentials)
        # would otherwise be indistinguishable from a normal queue timeout --
        # log it so it's diagnosable, without treating it as the overall
        # request's failure (the caller falls back to the simulator either way).
        print(f"[quantum] IBM hardware run failed, falling back to simulator: {exc}", file=sys.stderr)
        LAST_IBM_ERROR["message"] = _redact(f"{type(exc).__name__}: {exc}")
        return None
