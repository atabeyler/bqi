import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('../src/db/client.js', () => ({ query: (...args) => queryMock(...args) }));
vi.mock('../src/services/verify.js', () => ({ verifyFix: vi.fn() }));

const { runVerificationJob, waitForVerification, claimNextVerification } = await import('../src/services/verificationQueue.js');

const job = { id: 'job-1', org_id: 'org-1', requested_by: 'user-1', finding_id: 'finding-1' };

beforeEach(() => { queryMock.mockReset(); queryMock.mockResolvedValue({ rows: [] }); });

describe('verification queue', () => {
  it('stores the verifier outcome on the claimed job', async () => {
    const outcome = { result: 'FIX_VERIFIED', detail: 'the original template no longer matches' };
    const run = vi.fn().mockResolvedValue(outcome);
    await expect(runVerificationJob(job, run)).resolves.toEqual(outcome);
    expect(run).toHaveBeenCalledWith('org-1', 'user-1', 'finding-1');
    const [sql, params] = queryMock.mock.calls.at(-1);
    expect(sql).toMatch(/SET status = 'DONE'/);
    expect(JSON.parse(params[0])).toEqual(outcome);
    expect(params[1]).toBe('job-1');
  });

  it('turns a verifier crash into an INCONCLUSIVE outcome instead of leaving the job running', async () => {
    const run = vi.fn().mockRejectedValue(new Error('spawn nuclei ENOENT'));
    const outcome = await runVerificationJob(job, run);
    expect(outcome.result).toBe('INCONCLUSIVE');
    expect(outcome.detail).toContain('spawn nuclei ENOENT');
    expect(JSON.parse(queryMock.mock.calls.at(-1)[1][0])).toEqual(outcome);
  });

  it('reports a finding deleted meanwhile as INCONCLUSIVE', async () => {
    const outcome = await runVerificationJob(job, vi.fn().mockResolvedValue(null));
    expect(outcome.result).toBe('INCONCLUSIVE');
  });

  it('returns the outcome once the job is DONE and null when the worker never answers', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ status: 'RUNNING' }] })
      .mockResolvedValueOnce({ rows: [{ status: 'DONE', outcome: { result: 'FIX_VERIFIED', detail: 'ok' } }] });
    await expect(waitForVerification('job-1', { timeoutMs: 1000, pollMs: 1 })).resolves.toEqual({ result: 'FIX_VERIFIED', detail: 'ok' });

    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [{ status: 'QUEUED' }] });
    await expect(waitForVerification('job-2', { timeoutMs: 20, pollMs: 5 })).resolves.toBeNull();
  });

  it('claims queued jobs without blocking other workers', async () => {
    queryMock.mockResolvedValueOnce({ rows: [job] });
    await expect(claimNextVerification('worker-1')).resolves.toEqual(job);
    expect(queryMock.mock.calls[0][0]).toMatch(/FOR UPDATE SKIP LOCKED/);
  });
});
