import { describe, it, expect, vi, beforeEach } from 'vitest';

const researchWebMock = vi.fn(async () => [{ title: 'Result', url: 'https://example.com', snippet: 'x' }]);
vi.mock('./webResearch.js', () => ({
  researchWeb: (...args) => researchWebMock(...args),
  formatResearchContext: (results) => (results.length ? `[web] ${results.length} result(s)` : ''),
}));
vi.mock('./ai.js', () => ({
  getCategoryGroup: () => 'defense',
  CATEGORY_GROUP_SOURCES: { defense: { local: ['mevzuat.gov.tr'], international: [] } },
}));

const { gatherResearchContext } = await import('./analysisResearch.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('gatherResearchContext', () => {
  it('runs the web-search queries for the default (standart) depth', async () => {
    const context = await gatherResearchContext('savunma', 'İHA teknolojisi');
    expect(researchWebMock).toHaveBeenCalled();
    expect(context).toContain('[web]');
  });

  it('runs the web-search queries when depth is explicitly derin', async () => {
    const context = await gatherResearchContext('savunma', 'İHA teknolojisi', 'derin');
    expect(researchWebMock).toHaveBeenCalled();
    expect(context).toContain('[web]');
  });

  it('skips the web-search round-trip entirely for hizli depth', async () => {
    const context = await gatherResearchContext('savunma', 'İHA teknolojisi', 'hizli');
    expect(researchWebMock).not.toHaveBeenCalled();
    expect(context).toBe('');
  });

  // P0-01 fix: RESTRICTED/CONFIDENTIAL topic text used to reach DuckDuckGo's
  // public HTTP endpoint even though the same request's cloud AI calls are
  // already blocked by dataEgressPolicy.ts -- gatherResearchContext() must
  // never call researchWeb() at all for those classifications, matching the
  // AI-provider block rather than only redacting the response afterward.
  it('skips the web-search round-trip entirely for a RESTRICTED classification', async () => {
    const context = await gatherResearchContext('savunma', 'İHA teknolojisi', 'standart', 'RESTRICTED');
    expect(researchWebMock).not.toHaveBeenCalled();
    expect(context).toBe('');
  });

  it('skips the web-search round-trip entirely for a CONFIDENTIAL classification', async () => {
    const context = await gatherResearchContext('savunma', 'İHA teknolojisi', 'derin', 'CONFIDENTIAL');
    expect(researchWebMock).not.toHaveBeenCalled();
    expect(context).toBe('');
  });

  it('still runs web search for PUBLIC/INTERNAL classifications', async () => {
    const context = await gatherResearchContext('ekonomi', 'enflasyon', 'standart', 'INTERNAL');
    expect(researchWebMock).toHaveBeenCalled();
    expect(context).toContain('[web]');
  });
});
