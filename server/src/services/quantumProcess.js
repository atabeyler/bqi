import { spawn } from 'child_process';
import { logger } from '../lib/logger.js';
import { recordRequestMetric } from '../lib/requestMetrics.js';

/**
 * Resolves the (command, args) to spawn for a quantum worker call:
 * `python3 <script.py>` (PYTHON_BIN overridable for local dev setups with a
 * differently-named interpreter).
 */
export function resolveQuantumCommand(_mode, scriptPath) {
  const pythonBin = process.env.PYTHON_BIN || 'python3';
  return { bin: pythonBin, args: [scriptPath] };
}

/**
 * Probes that the quantum worker interpreter actually exists and can import
 * qiskit, instead of just checking that env vars/config are present. Used by
 * the readiness endpoint so "quantum worker down" (missing interpreter,
 * broken qiskit install) shows up as a real readiness failure. Kept
 * deliberately short-timeout since this runs on every readiness poll.
 */
export function checkQuantumWorkerHealth(timeoutMs = 3000) {
  const pythonBin = process.env.PYTHON_BIN || 'python3';
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let proc;
    try {
      proc = spawn(pythonBin, ['-c', 'import qiskit'], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      return finish({ ok: false, error: err?.message || String(err) });
    }

    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish({ ok: false, error: 'timeout' });
    }, timeoutMs);

    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: err?.message || String(err) });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0 ? { ok: true } : { ok: false, error: stderr.trim().slice(0, 300) || `exit ${code}` });
    });
  });
}

// Caps how many Python/Qiskit subprocesses (scenario, portfolio, fraud —
// each is CPU/RAM-heavy on its own) can run at once across the whole
// process, instead of each service spawning unboundedly under load. Calls
// beyond the cap queue in arrival order and run as slots free up.
const MAX_CONCURRENT_QUANTUM_WORKERS = Number(process.env.QUANTUM_MAX_CONCURRENCY) || 4;
let activeWorkers = 0;
const waitQueue = [];

function acquireSlot() {
  if (activeWorkers < MAX_CONCURRENT_QUANTUM_WORKERS) {
    activeWorkers += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waitQueue.push(resolve));
}

function releaseSlot() {
  const next = waitQueue.shift();
  if (next) {
    next();
  } else {
    activeWorkers = Math.max(0, activeWorkers - 1);
  }
}

export function getQuantumWorkerPoolStats() {
  return { active: activeWorkers, queued: waitQueue.length, maxConcurrency: MAX_CONCURRENT_QUANTUM_WORKERS };
}

/**
 * Runs one quantum worker subprocess end to end: waits for a free pool slot,
 * spawns `python3 <scriptPath>`, writes `payload` (JSON-stringified) to
 * stdin, enforces `timeoutMs`, and resolves the parsed stdout JSON (or null
 * on any failure — missing interpreter, non-zero exit, timeout, bad JSON,
 * or a `{error}` payload from the script itself). Centralizes the
 * spawn/timeout/concurrency handling that quantum.js, portfolioOptimizer.js
 * and fraudDetection.js previously duplicated three times.
 *
 * @param {{mode: string, scriptPath: string, payload: object, timeoutMs: number, label: string}} opts
 */
// Per-request array-length caps (MAX_SCENARIOS etc. in the calling
// services) bound how many items go into a payload, but not the serialized
// byte size of any one item's string fields (e.g. a very long `id`). This
// is the last-resort ceiling on the whole stdin write, and on how much
// stdout/stderr a runaway or misbehaving worker gets to accumulate in
// memory before being cut off.
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB

export async function runQuantumWorker({ mode, scriptPath, payload, timeoutMs, label }) {
  const startedAt = Date.now();
  const payloadJson = JSON.stringify(payload);
  if (Buffer.byteLength(payloadJson) > MAX_PAYLOAD_BYTES) {
    logger.warn({ bytes: Buffer.byteLength(payloadJson) }, `[${label}] Payload exceeds MAX_PAYLOAD_BYTES, refusing to spawn worker`);
    recordRequestMetric(`quantum.${label}`, Date.now() - startedAt, 413);
    return null;
  }
  await acquireSlot();
  try {
    const result = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      let proc;
      try {
        const { bin, args } = resolveQuantumCommand(mode, scriptPath);
        proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        logger.warn({ err }, `[${label}] Failed to start Python process`);
        return finish(null);
      }

      let out = '';
      let err = '';
      let outputOverflowed = false;
      const timer = setTimeout(() => {
        logger.warn(`[${label}] Timed out — proceeding without worker result`);
        proc.kill('SIGKILL');
        finish(null);
      }, timeoutMs);

      const appendCapped = (current, chunk) => {
        if (current.length >= MAX_OUTPUT_BYTES) {
          if (!outputOverflowed) {
            outputOverflowed = true;
            logger.warn(`[${label}] Worker output exceeded MAX_OUTPUT_BYTES, killing process`);
            proc.kill('SIGKILL');
          }
          return current;
        }
        return current + chunk;
      };
      proc.stdout.on('data', (d) => { out = appendCapped(out, d); });
      proc.stderr.on('data', (d) => { err = appendCapped(err, d); });
      proc.on('error', (e) => {
        clearTimeout(timer);
        logger.warn({ err: e }, `[${label}] Process error`);
        finish(null);
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (settled) return;
        if (outputOverflowed) {
          return finish(null);
        }
        if (code !== 0) {
          logger.warn({ code, stderr: err.trim().slice(0, 300) }, `[${label}] Worker process failed`);
          return finish(null);
        }
        try {
          const parsed = JSON.parse(out);
          if (parsed.error) {
            logger.warn({ workerError: parsed.error }, `[${label}] Worker reported an error`);
            return finish(null);
          }
          finish(parsed);
        } catch (e) {
          logger.warn({ err: e }, `[${label}] Failed to parse worker output`);
          finish(null);
        }
      });

      proc.stdin.on('error', () => {});
      try {
        proc.stdin.write(payloadJson);
        proc.stdin.end();
      } catch (e) {
        logger.warn({ err: e }, `[${label}] Failed to write worker stdin`);
      }
    });
    recordRequestMetric(`quantum.${label}`, Date.now() - startedAt, result === null ? 500 : 200);
    return result;
  } finally {
    releaseSlot();
  }
}
