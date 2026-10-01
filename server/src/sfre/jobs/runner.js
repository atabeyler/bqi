import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { computeRun } from '../pipeline.js';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.js');
export const DEFAULT_TIMEOUT_MS = 120000;

let active = 0;
export const MAX_CONCURRENT = Number(process.env.SFRE_MAX_CONCURRENT_RUNS) || 2;

/**
 * Executes computeRun in a worker thread (API event loop stays responsive), with a hard timeout and a concurrency cap.
 * SFRE_INLINE=1 (or opts.inline) runs in-process (tests / debugging).
 */
export function runInWorker(request, registryStates, { timeoutMs = DEFAULT_TIMEOUT_MS, inline = process.env.SFRE_INLINE === '1' } = {}) {
  if (inline) {
    try { return Promise.resolve(computeRun(request, { registryStates })); } catch (e) { return Promise.reject(e); }
  }
  if (active >= MAX_CONCURRENT) return Promise.reject(Object.assign(new Error('too many concurrent SFRE runs'), { code: 'BUSY' }));
  active += 1;
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { workerData: { request, registryStates }, execArgv: [] }) // execArgv [] : do not inherit the server's `--import ./src/instrument.js` (a .ts file only tsx can load);
    const timer = setTimeout(() => { done(); w.terminate(); reject(Object.assign(new Error(`run exceeded ${timeoutMs}ms`), { code: 'TIMEOUT' })); }, timeoutMs);
    let finished = false;
    const done = () => { if (finished) return; finished = true; clearTimeout(timer); active -= 1; };
    w.once('message', (m) => { done(); if (m.ok) resolve(m.out); else reject(Object.assign(new Error(m.message), { code: m.code })); });
    w.once('error', (e) => { done(); reject(e); });
    w.once('exit', () => done());
  });
}
