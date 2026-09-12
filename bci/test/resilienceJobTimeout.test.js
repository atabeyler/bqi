import { describe, expect, it } from 'vitest';
import { resolveJobTimeoutMs } from '../src/services/jobQueue.js';

describe('Smart Resilience worker timeout sizing', () => {
  it('gives broad Nuclei profiles enough worker time to finish', () => {
    const standard = { engine_options: { nuclei: { scanProfile: 'STANDARD' } } };
    const full = { engine_options: { nuclei: { scanProfile: 'FULL_SAFE' } } };
    expect(resolveJobTimeoutMs(standard)).toBe(12 * 60_000);
    expect(resolveJobTimeoutMs(full)).toBe(32 * 60_000);
  });

  it('adds sequential engine budgets so Smart Fuzz does not inherit Nuclei\'s exhausted deadline', () => {
    const combined = {
      selected_engine_ids: ['nuclei', 'naabu', 'http-fuzz'],
      engine_options: { nuclei: { scanProfile: 'STANDARD' }, 'http-fuzz': { baseProfile: 'STANDARD' } },
    };
    expect(resolveJobTimeoutMs(combined)).toBe(27 * 60_000);
  });

  it('has no fixed worker deadline for a user-stoppable durationless UNLIMITED plan', () => {
    const job = { engine_options: { 'availability-probe': { requestedPlan: { requestCountMode: 'UNLIMITED', durationMs: null } } } };
    expect(resolveJobTimeoutMs(job)).toBeNull();
  });

  it('derives a finite deadline from the selected duration without reducing it', () => {
    const job = { engine_options: { 'availability-probe': { requestedPlan: { requestCountMode: '10000', durationMs: 600_000, requestTimeoutMs: 20_000 } } } };
    expect(resolveJobTimeoutMs(job)).toBeGreaterThan(600_000);
  });
});
