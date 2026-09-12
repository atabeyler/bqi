import { describe, expect, it } from 'vitest';
import { checkQuantumWorkerHealth, getQuantumWorkerPoolStats, runQuantumWorker } from './quantumProcess.js';
import { getMetricsSnapshot } from '../lib/requestMetrics.js';

describe('quantum worker pool', () => {
  it('reports idle pool stats with the configured concurrency cap', () => {
    const stats = getQuantumWorkerPoolStats();
    expect(stats.active).toBe(0);
    expect(stats.queued).toBe(0);
    expect(stats.maxConcurrency).toBeGreaterThan(0);
  });

  it('resolves null when the interpreter cannot be spawned', async () => {
    const original = process.env.PYTHON_BIN;
    process.env.PYTHON_BIN = '/no/such/interpreter';
    try {
      const result = await runQuantumWorker({
        mode: 'scenario', scriptPath: '/tmp/does-not-matter.py', payload: {}, timeoutMs: 2000, label: 'Test',
      });
      expect(result).toBeNull();
    } finally {
      if (original === undefined) delete process.env.PYTHON_BIN;
      else process.env.PYTHON_BIN = original;
    }
  });

  it('releases the pool slot after a failed run so the pool stays usable', async () => {
    const original = process.env.PYTHON_BIN;
    process.env.PYTHON_BIN = '/no/such/interpreter';
    try {
      await runQuantumWorker({ mode: 'scenario', scriptPath: '/tmp/x.py', payload: {}, timeoutMs: 2000, label: 'Test' });
      expect(getQuantumWorkerPoolStats().active).toBe(0);
    } finally {
      if (original === undefined) delete process.env.PYTHON_BIN;
      else process.env.PYTHON_BIN = original;
    }
  });

  it('records a failed-run metric under quantum.<label> for observability', async () => {
    const original = process.env.PYTHON_BIN;
    process.env.PYTHON_BIN = '/no/such/interpreter';
    const label = `MetricsTest-${Date.now()}`;
    try {
      await runQuantumWorker({ mode: 'scenario', scriptPath: '/tmp/x.py', payload: {}, timeoutMs: 2000, label });
      const entry = getMetricsSnapshot().find((m) => m.name === `quantum.${label}`);
      expect(entry.count).toBe(1);
      expect(entry.errorRate).toBe(100);
    } finally {
      if (original === undefined) delete process.env.PYTHON_BIN;
      else process.env.PYTHON_BIN = original;
    }
  });

  it('kills a hung process and resolves null once the timeout elapses, without blocking the pool', async () => {
    const original = process.env.PYTHON_BIN;
    // Stands in for a Python worker that hangs (e.g. stuck on an IBM queue
    // wait or an infinite loop) -- `sleep 5` never produces stdout and
    // outlives the short timeoutMs below, exercising the SIGKILL path.
    process.env.PYTHON_BIN = 'sleep';
    try {
      const startedAt = Date.now();
      const result = await runQuantumWorker({
        mode: 'scenario', scriptPath: '5', payload: {}, timeoutMs: 300, label: 'HangTest',
      });
      expect(result).toBeNull();
      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(getQuantumWorkerPoolStats().active).toBe(0);
    } finally {
      if (original === undefined) delete process.env.PYTHON_BIN;
      else process.env.PYTHON_BIN = original;
    }
  }, 10000);

  it('resolves null when the worker process exits with a non-zero code', async () => {
    const original = process.env.PYTHON_BIN;
    // `false` ignores its args and exits 1 immediately -- stands in for a
    // Python worker crashing (uncaught exception, missing dependency, etc.)
    // distinctly from the spawn-failure (ENOENT) case above.
    process.env.PYTHON_BIN = 'false';
    try {
      const result = await runQuantumWorker({
        mode: 'scenario', scriptPath: 'irrelevant', payload: {}, timeoutMs: 2000, label: 'CrashTest',
      });
      expect(result).toBeNull();
    } finally {
      if (original === undefined) delete process.env.PYTHON_BIN;
      else process.env.PYTHON_BIN = original;
    }
  });

  it('resolves null when the worker produces non-JSON output', async () => {
    const original = process.env.PYTHON_BIN;
    process.env.PYTHON_BIN = 'echo';
    try {
      const result = await runQuantumWorker({
        mode: 'scenario', scriptPath: 'not valid json', payload: {}, timeoutMs: 2000, label: 'GarbageTest',
      });
      expect(result).toBeNull();
    } finally {
      if (original === undefined) delete process.env.PYTHON_BIN;
      else process.env.PYTHON_BIN = original;
    }
  });

  it('checkQuantumWorkerHealth reports not-ok when the interpreter cannot import qiskit or is missing', async () => {
    const original = process.env.PYTHON_BIN;
    process.env.PYTHON_BIN = '/no/such/interpreter';
    try {
      const result = await checkQuantumWorkerHealth(1000);
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    } finally {
      if (original === undefined) delete process.env.PYTHON_BIN;
      else process.env.PYTHON_BIN = original;
    }
  });
});
