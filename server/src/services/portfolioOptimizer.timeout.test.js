import { describe, expect, it, vi } from 'vitest';

const runQuantumWorkerMock = vi.fn(async () => null);
vi.mock('./quantumProcess.js', () => ({ runQuantumWorker: (...args) => runQuantumWorkerMock(...args) }));

const { computeOptimalAllocation } = await import('./portfolioOptimizer.js');

describe('computeOptimalAllocation timeout scaling', () => {
  it('uses the single-circuit timeout for 8 or fewer items', async () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ id: `I${i}`, value: 10, cost: 10 }));
    await computeOptimalAllocation(items, 60);
    const { timeoutMs } = runQuantumWorkerMock.mock.calls.at(-1)[0];
    expect(timeoutMs).toBe(45000);
  });

  it('scales the timeout with the number of hybrid partitions above 8 items', async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ id: `I${i}`, value: 10, cost: 10 }));
    await computeOptimalAllocation(items, 60);
    const { timeoutMs } = runQuantumWorkerMock.mock.calls.at(-1)[0];
    // ceil(20 / 8) = 3 partitions
    expect(timeoutMs).toBe(45000 * 3);
  });

  it('caps the partition count at MAX_TOTAL_ITEMS (24) worth of partitions', async () => {
    const items = Array.from({ length: 500 }, (_, i) => ({ id: `I${i}`, value: 10, cost: 10 }));
    await computeOptimalAllocation(items, 60);
    const { timeoutMs } = runQuantumWorkerMock.mock.calls.at(-1)[0];
    // ceil(24 / 8) = 3 partitions -- the same as the 20-item case, since the
    // Python side truncates to MAX_TOTAL_ITEMS regardless of how many were sent.
    expect(timeoutMs).toBe(45000 * 3);
  });
});
