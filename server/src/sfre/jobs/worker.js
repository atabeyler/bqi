import { parentPort, workerData } from 'node:worker_threads';
import { computeRun } from '../pipeline.js';

// Runs one pipeline computation off the API thread. Input/outputs are plain data (structured clone).
try {
  parentPort.postMessage({ ok: true, out: computeRun(workerData.request, { registryStates: workerData.registryStates }) });
} catch (e) {
  parentPort.postMessage({ ok: false, code: e.code || 'ERROR', message: String(e?.message || e) });
}
