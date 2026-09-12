import { describe, it, expect, beforeEach } from 'vitest';
import { orderProviders, type ProviderInfo } from './aiProviders.js';
import { recordRequestMetric, resetRequestMetrics } from '../lib/requestMetrics.js';

// A-04 (technical audit): orderProviders is the pure scoring/sorting core
// of the policy-based provider router, exercised here with fake
// ProviderInfo entries so the result doesn't depend on which real API keys
// happen to be configured in the process running the test.
function fakeProvider(key: string, contextWindowTokens = 200000): ProviderInfo {
  return { key, name: key, contextWindowTokens, isConfigured: () => true };
}

beforeEach(() => {
  resetRequestMetrics();
});

describe('orderProviders', () => {
  it('preserves the given order when no provider has enough history yet (cold start)', () => {
    const providers = [fakeProvider('claude'), fakeProvider('gemini'), fakeProvider('openai')];
    const order = orderProviders(providers, 100);
    expect(order.map((p) => p.key)).toEqual(['claude', 'gemini', 'openai']);
  });

  it('drops a provider with a worse rolling success rate below one that is healthy', () => {
    const providers = [fakeProvider('claude'), fakeProvider('gemini')];
    for (let i = 0; i < 6; i++) recordRequestMetric('ai.claude', 100, 500); // all failures, past the min-sample threshold
    for (let i = 0; i < 6; i++) recordRequestMetric('ai.gemini', 100, 200); // all successes

    const order = orderProviders(providers, 100);
    expect(order.map((p) => p.key)).toEqual(['gemini', 'claude']);
  });

  it('breaks a success-rate tie by lower p50 latency', () => {
    const providers = [fakeProvider('claude'), fakeProvider('gemini')];
    for (let i = 0; i < 6; i++) recordRequestMetric('ai.claude', 900, 200);
    for (let i = 0; i < 6; i++) recordRequestMetric('ai.gemini', 100, 200);

    const order = orderProviders(providers, 100);
    expect(order.map((p) => p.key)).toEqual(['gemini', 'claude']);
  });

  it('excludes a provider whose context window cannot fit the prompt when an alternative can', () => {
    const providers = [fakeProvider('openai', 128000), fakeProvider('gemini', 1000000)];
    const hugePromptChars = 600000 * 4; // ~600k tokens, over openai's window but under gemini's
    const order = orderProviders(providers, hugePromptChars);
    expect(order.map((p) => p.key)).toEqual(['gemini']);
  });

  it('falls back to every configured provider when none fit the estimated context window', () => {
    const providers = [fakeProvider('openai', 128000), fakeProvider('claude', 200000)];
    const enormousPromptChars = 5_000_000 * 4;
    const order = orderProviders(providers, enormousPromptChars);
    expect(order.map((p) => p.key).sort()).toEqual(['claude', 'openai']);
  });
});
