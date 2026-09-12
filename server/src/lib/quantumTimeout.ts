/**
 * Shared timeout budget for the Python quantum subprocesses that can
 * optionally run on real IBM Quantum hardware (scenario_quantum.py,
 * portfolio_optimizer.py). _ibm_backend.py's run_on_ibm_hardware() polls
 * for up to IBM_QUANTUM_WAIT_SECONDS before giving up and letting the
 * caller fall back to the local simulator — the Node-side subprocess
 * timeout has to be longer than that wait, or the whole subprocess (not
 * just the IBM attempt) gets SIGKILLed mid-computation whenever IBM
 * credentials are configured.
 */
const IBM_CONFIGURED = Boolean(process.env.IBM_QUANTUM_TOKEN && process.env.IBM_QUANTUM_INSTANCE);
const IBM_WAIT_MS = Number(process.env.IBM_QUANTUM_WAIT_SECONDS || '60') * 1000;
const IBM_BUFFER_MS = 10000; // margin for queue polling / transpile / network overhead beyond the wait itself

export function withIbmTimeout(baseMs: number): number {
  return IBM_CONFIGURED ? baseMs + IBM_WAIT_MS + IBM_BUFFER_MS : baseMs;
}
