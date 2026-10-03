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

const { gatherResearchContext, isDemoWebResearchEnabled } = await import('./analysisResearch.js');

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.BQI_DEMO_WEB_RESEARCH;
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

// BQI_DEMO_WEB_RESEARCH: single opt-in flag for live demo prep -- must never
// change default (unset) behavior, and must never touch RBAC/classification
// access itself (that's a separate concern -- see decisionIntelligence.js's
// classifyData and rbac.js's canAccessClassification, neither of which this
// flag reads or affects). It only changes whether a request that's already
// allowed to generate a CONFIDENTIAL/RESTRICTED report also gets real web
// grounding for it.
describe('BQI_DEMO_WEB_RESEARCH', () => {
  it('isDemoWebResearchEnabled is false by default (env var unset)', () => {
    expect(isDemoWebResearchEnabled()).toBe(false);
  });

  it('isDemoWebResearchEnabled is false for any value other than the literal string "true"', () => {
    process.env.BQI_DEMO_WEB_RESEARCH = '1';
    expect(isDemoWebResearchEnabled()).toBe(false);
    process.env.BQI_DEMO_WEB_RESEARCH = 'TRUE';
    expect(isDemoWebResearchEnabled()).toBe(false);
  });

  it('isDemoWebResearchEnabled is true when set to "true"', () => {
    process.env.BQI_DEMO_WEB_RESEARCH = 'true';
    expect(isDemoWebResearchEnabled()).toBe(true);
  });

  it('does NOT change default (flag unset) behavior -- CONFIDENTIAL/RESTRICTED still skip research', async () => {
    const restricted = await gatherResearchContext('savunma', 'İHA teknolojisi', 'standart', 'RESTRICTED');
    const confidential = await gatherResearchContext('savunma', 'İHA teknolojisi', 'derin', 'CONFIDENTIAL');
    expect(researchWebMock).not.toHaveBeenCalled();
    expect(restricted).toBe('');
    expect(confidential).toBe('');
  });

  it('when enabled, runs real web search even for CONFIDENTIAL classification', async () => {
    process.env.BQI_DEMO_WEB_RESEARCH = 'true';
    const context = await gatherResearchContext('savunma', 'İHA teknolojisi', 'derin', 'CONFIDENTIAL');
    expect(researchWebMock).toHaveBeenCalled();
    expect(context).toContain('[web]');
  });

  it('when enabled, runs real web search even for RESTRICTED classification', async () => {
    process.env.BQI_DEMO_WEB_RESEARCH = 'true';
    const context = await gatherResearchContext('savunma', 'İHA teknolojisi', 'standart', 'RESTRICTED');
    expect(researchWebMock).toHaveBeenCalled();
    expect(context).toContain('[web]');
  });

  it('does not override the "hizli" depth skip even when enabled', async () => {
    process.env.BQI_DEMO_WEB_RESEARCH = 'true';
    const context = await gatherResearchContext('savunma', 'İHA teknolojisi', 'hizli', 'CONFIDENTIAL');
    expect(researchWebMock).not.toHaveBeenCalled();
    expect(context).toBe('');
  });
});

describe('buildSearchQuery', () => {
  it('turns a natural-language brief into a short keyword query', async () => {
    const { buildSearchQuery } = await import('./analysisResearch.js');
    const q = buildSearchQuery('Kısa zaman içinde turkiyede yaşanmakta olan fon dolandırıcılığı konusu ile ilgili olası sonuçlar ve yapılması gerekenler rapor yaz');
    expect(q).toBe('turkiyede fon dolandırıcılığı');
  });
});

describe('gatherResearchDetailed', () => {
  it('reports ok + source count when results come back', async () => {
    const { gatherResearchDetailed } = await import('./analysisResearch.js');
    const r = await gatherResearchDetailed('ekonomi', 'enflasyon', 'standart', 'INTERNAL');
    expect(r.status).toBe('ok');
    expect(r.sourceCount).toBeGreaterThan(0);
  });
  it('reports empty when no results', async () => {
    researchWebMock.mockResolvedValue([]);
    const { gatherResearchDetailed } = await import('./analysisResearch.js');
    const r = await gatherResearchDetailed('ekonomi', 'enflasyon', 'standart', 'INTERNAL');
    expect(r.status).toBe('empty');
  });
  it('reports why research was skipped', async () => {
    const { gatherResearchDetailed } = await import('./analysisResearch.js');
    expect((await gatherResearchDetailed('savunma', 'x', 'hizli')).status).toBe('skipped_depth');
    expect((await gatherResearchDetailed('savunma', 'x', 'derin', 'CONFIDENTIAL')).status).toBe('skipped_classification');
  });
});
