import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateAnalysisMock = vi.fn();
vi.mock('./ai.js', () => ({
  generateAnalysis: (...args) => generateAnalysisMock(...args),
}));

import { runRedTeamReview, RedTeamReviewError } from './redTeam.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runRedTeamReview (BQI-016)', () => {
  it('rejects empty content rather than calling the AI provider', async () => {
    await expect(runRedTeamReview('')).rejects.toThrow(RedTeamReviewError);
    expect(generateAnalysisMock).not.toHaveBeenCalled();
  });

  it('returns the critique text and provider on success', async () => {
    generateAnalysisMock.mockResolvedValueOnce({ provider: 'Claude (Anthropic)', content: 'Varsayımlar: ...' });
    const result = await runRedTeamReview('Ana analiz metni', { category: 'savunma', classification: 'INTERNAL' });
    expect(result).toEqual({ critique: 'Varsayımlar: ...', provider: 'Claude (Anthropic)' });
  });

  it('passes the classification through to generateAnalysis so policy applies identically to the critique pass', async () => {
    generateAnalysisMock.mockResolvedValueOnce({ provider: 'Claude', content: 'x' });
    await runRedTeamReview('içerik', { category: 'savunma', classification: 'RESTRICTED' });
    const [, , , classification] = generateAnalysisMock.mock.calls[0];
    expect(classification).toBe('RESTRICTED');
  });

  it('never lets the critique system prompt request a replacement decision (structural check)', async () => {
    generateAnalysisMock.mockResolvedValueOnce({ provider: 'Claude', content: 'x' });
    await runRedTeamReview('içerik', {});
    const [systemPrompt] = generateAnalysisMock.mock.calls[0];
    expect(systemPrompt).toMatch(/ELEŞTİRMEK/);
    expect(systemPrompt).toMatch(/Varsayımlar|VARSAYIMLAR/);
    expect(systemPrompt).toMatch(/Karşıt kanıt|KARŞIT KANIT/i);
  });

  it('propagates a data-egress policy denial as-is rather than masking it as a generic failure', async () => {
    const policyErr = new Error('denied');
    policyErr.code = 'DATA_EGRESS_POLICY_DENIED';
    generateAnalysisMock.mockRejectedValueOnce(policyErr);
    await expect(runRedTeamReview('içerik', { classification: 'RESTRICTED' })).rejects.toBe(policyErr);
  });

  it('wraps an ordinary provider failure as RedTeamReviewError', async () => {
    generateAnalysisMock.mockRejectedValueOnce(new Error('provider timeout'));
    await expect(runRedTeamReview('içerik', {})).rejects.toThrow(RedTeamReviewError);
  });
});
