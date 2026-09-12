import { describe, it, expect, vi } from 'vitest';
import { routeAnalysisGeneration, routeConsultChat, AllEnginesUnavailableError, ENGINE } from './analysisRouter.js';

// Full priority-chain coverage for the Analysis Router (task spec point 4):
//   1. Cloud reachable       -> Q CLOUD
//   2. Cloud unreachable     -> Q LOCAL LLM
//   3. Local LLM unavailable -> a clear, honest error (NOT Q LOCAL DATA --
//                                see the "audit finding" tests below for why
//                                a generate request never falls to the
//                                extractive/archive engine)
//   4. Nothing available     -> a clear, honest error
describe('routeAnalysisGeneration', () => {
  it('1. uses the cloud call when online, tagging the result ENGINE.CLOUD', async () => {
    const cloudCall = vi.fn(async () => ({ title: 'Rapor', content: 'İçerik', provider: 'Claude (Anthropic)' }));
    const nativeAIQuery = vi.fn();

    const result = await routeAnalysisGeneration({ isOffline: false, cloudCall, nativeAIQuery, generateRequest: {} });

    expect(result.engine).toBe(ENGINE.CLOUD);
    expect(result.content).toBe('İçerik');
    expect(nativeAIQuery).not.toHaveBeenCalled();
  });

  it('2. routes to the local LLM when offline and it answers', async () => {
    const cloudCall = vi.fn();
    const nativeAIQuery = vi.fn(async (req) => {
      expect(req.mode).toBe('generate');
      return { ok: true, capability: 'local-llm', type: 'analysis', result: { title: 'Taslak', content: 'Yerel içerik', sources: [] } };
    });

    const result = await routeAnalysisGeneration({ isOffline: true, cloudCall, nativeAIQuery, generateRequest: { category: 'finans', prompt: 'x' } });

    expect(result.engine).toBe(ENGINE.LOCAL_LLM);
    expect(result.content).toBe('Yerel içerik');
    expect(cloudCall).not.toHaveBeenCalled();
  });

  // Audit finding: a "generate a new analysis" request used to accept an
  // offline-extractive/archive-synthesis answer as if it were a real
  // generated analysis of the requested topic, when it was actually just a
  // synthesis of unrelated past reports. registry.js's offline-extractive
  // provider now refuses mode:'generate' outright; this asserts the
  // router's own belt-and-suspenders guard for the same case (e.g. if a
  // native layer implementation somehow still returns one).
  it('3. treats an offline-extractive/archive-synthesis response as unavailable, never as a real analysis', async () => {
    const nativeAIQuery = vi.fn(async () => ({
      ok: true,
      capability: 'offline-extractive',
      type: 'archive-synthesis',
      result: { generated: false, matches: [{ id: 'a', title: 'Rapor A', category: 'finans', createdAt: new Date().toISOString(), summary: 'özet' }], note: 'not generated' },
    }));

    await expect(routeAnalysisGeneration({ isOffline: true, cloudCall: vi.fn(), nativeAIQuery, generateRequest: {} }))
      .rejects.toBeInstanceOf(AllEnginesUnavailableError);
  });

  it('4. throws AllEnginesUnavailableError when nothing can answer', async () => {
    const nativeAIQuery = vi.fn(async () => ({ ok: false, error: 'no model' }));
    await expect(routeAnalysisGeneration({ isOffline: true, cloudCall: vi.fn(), nativeAIQuery, generateRequest: {} }))
      .rejects.toBeInstanceOf(AllEnginesUnavailableError);
  });

  it('4b. throws AllEnginesUnavailableError when offline with no native bridge at all (plain web build)', async () => {
    await expect(routeAnalysisGeneration({ isOffline: true, cloudCall: vi.fn(), nativeAIQuery: undefined, generateRequest: {} }))
      .rejects.toBeInstanceOf(AllEnginesUnavailableError);
  });

  it('falls back locally when the connectivity state is stale and the cloud call fails, but still refuses an offline-extractive answer for generate', async () => {
    const cloudCall = vi.fn(async () => { throw new Error('cloud boom'); });
    const nativeAIQuery = vi.fn(async () => ({ ok: true, capability: 'offline-extractive', type: 'archive-synthesis', result: { matches: [], note: 'yerel' } }));
    await expect(routeAnalysisGeneration({ isOffline: false, cloudCall, nativeAIQuery, generateRequest: {} }))
      .rejects.toBeInstanceOf(AllEnginesUnavailableError);
  });

  it('accepts a local-llm answer even when falling back from a stale-online cloud failure', async () => {
    const cloudCall = vi.fn(async () => { throw new Error('cloud boom'); });
    const nativeAIQuery = vi.fn(async () => ({ ok: true, capability: 'local-llm', type: 'analysis', result: { title: 'Taslak', content: 'Yerel içerik', sources: [] } }));
    const result = await routeAnalysisGeneration({ isOffline: false, cloudCall, nativeAIQuery, generateRequest: {} });
    expect(result.engine).toBe(ENGINE.LOCAL_LLM);
  });
});

describe('routeConsultChat', () => {
  it('cloud path returns ENGINE.CLOUD with the provider label', async () => {
    const cloudCall = vi.fn(async () => ({ content: 'cevap', provider: 'Claude (Anthropic)' }));
    const result = await routeConsultChat({ isOffline: false, cloudCall, nativeAIQuery: vi.fn(), chatText: 'soru' });
    expect(result.engine).toBe(ENGINE.CLOUD);
    expect(result.providerLabel).toBe('Q CLOUD');
  });

  it('offline generative answer is tagged ENGINE.LOCAL_LLM', async () => {
    const nativeAIQuery = vi.fn(async () => ({ ok: true, capability: 'local-llm', type: 'generated', text: 'cevap', sources: [] }));
    const result = await routeConsultChat({ isOffline: true, cloudCall: vi.fn(), nativeAIQuery, chatText: 'soru' });
    expect(result.engine).toBe(ENGINE.LOCAL_LLM);
    expect(result.content).toBe('cevap');
  });

  it('offline structured (find/summary/compare) answer is tagged ENGINE.LOCAL_DATA', async () => {
    const nativeAIQuery = vi.fn(async () => ({ ok: true, capability: 'offline-extractive', type: 'find', result: [] }));
    const result = await routeConsultChat({ isOffline: true, cloudCall: vi.fn(), nativeAIQuery, chatText: 'soru' });
    expect(result.engine).toBe(ENGINE.LOCAL_DATA);
    expect(result.structured).toEqual({ type: 'find', result: [] });
  });

  it('throws AllEnginesUnavailableError when the local provider reports failure', async () => {
    const nativeAIQuery = vi.fn(async () => ({ ok: false, error: 'kullanılamıyor' }));
    await expect(routeConsultChat({ isOffline: true, cloudCall: vi.fn(), nativeAIQuery, chatText: 'soru' }))
      .rejects.toBeInstanceOf(AllEnginesUnavailableError);
  });
});
