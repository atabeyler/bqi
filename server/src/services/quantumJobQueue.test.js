import { describe, expect, it } from 'vitest';
import { enqueueHardwareVerificationJob, ensureQuantumJobTables, startQuantumJobWorker, stopQuantumJobWorker } from './quantumJobQueue.js';

describe('quantum hardware job queue (no DATABASE_URL)', () => {
  it('enqueue returns null so callers fall back to inline processing', async () => {
    expect(process.env.DATABASE_URL).toBeUndefined();
    const jobId = await enqueueHardwareVerificationJob({ analysisId: 1, userCode: 'u1', kind: 'scenario', payload: [] });
    expect(jobId).toBeNull();
  });

  it('ensureQuantumJobTables is a no-op without a configured database', async () => {
    await expect(ensureQuantumJobTables()).resolves.toBeUndefined();
  });

  it('startQuantumJobWorker/stopQuantumJobWorker are no-ops without a configured database', () => {
    expect(() => startQuantumJobWorker(null)).not.toThrow();
    expect(() => stopQuantumJobWorker()).not.toThrow();
  });
});
