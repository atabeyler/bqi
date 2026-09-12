/**
 * BQI AI Provider Clients
 * Instantiates the three fallback providers (Claude -> Gemini -> OpenAI) via
 * the Vercel AI SDK, each only if its API key is configured. Split out of
 * ai.ts so the provider/model wiring is separate from prompt construction
 * and the generation call flow.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { getMetricsSnapshot } from '../lib/requestMetrics.js';

export const anthropicProvider = process.env.ANTHROPIC_API_KEY
  ? createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;
export const googleProvider = process.env.GEMINI_API_KEY
  ? createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;
export const openaiProvider = process.env.OPENAI_API_KEY
  ? createOpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

export const MODELS = {
  claudeText: 'claude-sonnet-4-6',
  claudeVoice: 'claude-haiku-4-5-20251001',
  gemini: 'gemini-3.5-flash',
  openai: 'gpt-4o',
};

export function getStatus(): { claude: boolean; gemini: boolean; openai: boolean } {
  return { claude: !!anthropicProvider, gemini: !!googleProvider, openai: !!openaiProvider };
}

export interface ProviderInfo {
  key: string;
  name: string;
  contextWindowTokens: number;
  isConfigured: () => boolean;
}

// Fixed order (Claude -> Gemini -> OpenAI) is preserved as the array order
// below -- pickProviderOrder only reshuffles it once real history exists
// (see the sort below), so a cold-started deployment behaves exactly like
// the old failure-only fallback until a provider actually earns a lower spot.
const PROVIDER_INFO: ProviderInfo[] = [
  { key: 'claude', name: 'Claude (Anthropic)', contextWindowTokens: 200000, isConfigured: () => !!anthropicProvider },
  { key: 'gemini', name: 'Gemini (Google)', contextWindowTokens: 1000000, isConfigured: () => !!googleProvider },
  { key: 'openai', name: 'GPT-4o (OpenAI)', contextWindowTokens: 128000, isConfigured: () => !!openaiProvider },
];

// A-04 (technical audit): the old fallback was purely failure-based --
// whichever configured provider came first in a fixed list was always tried
// first, regardless of how it had actually been performing. This scores
// each configured provider by its rolling success rate and p50 latency
// (see lib/requestMetrics.js's `ai.<provider>` entries, recorded by
// recordAiAttempt in aiGenerate.ts) and by whether the prompt plausibly fits
// its context window, so a provider having a bad day drops down the order
// instead of still being tried first on every single request. A provider
// with too little history yet (<MIN_SAMPLES calls) is treated as perfect/
// instant, which -- combined with the array order above and a stable sort
// -- reproduces the original fixed order until real history exists.
const MIN_SAMPLES_FOR_SCORING = 5;

function scoreProvider(key: string): { successRate: number; p50Ms: number } {
  const metric = getMetricsSnapshot().find((m) => m.name === `ai.${key}`);
  if (!metric || metric.count < MIN_SAMPLES_FOR_SCORING) return { successRate: 1, p50Ms: 0 };
  return { successRate: 1 - metric.errorRate / 100, p50Ms: metric.p50Ms };
}

// Split out from pickProviderOrder so it can be exercised directly with
// fake ProviderInfo entries in tests, independent of which real API keys
// happen to be configured in the process running the test.
export function orderProviders(configured: ProviderInfo[], promptLength: number): ProviderInfo[] {
  const roughTokens = Math.ceil(promptLength / 4);
  const fitsContext = configured.filter((p) => p.contextWindowTokens >= roughTokens);
  // If the prompt is too large for every configured provider's stated
  // context window, trying the best-scored one anyway beats failing
  // outright -- the provider's own API is the real limit, this is just a
  // best-effort ordering hint.
  const candidates = fitsContext.length > 0 ? fitsContext : configured;

  return candidates
    .map((p) => ({ provider: p, ...scoreProvider(p.key) }))
    .sort((a, b) => (b.successRate - a.successRate) || (a.p50Ms - b.p50Ms))
    .map((entry) => entry.provider);
}

export function pickProviderOrder(promptLength: number): ProviderInfo[] {
  return orderProviders(PROVIDER_INFO.filter((p) => p.isConfigured()), promptLength);
}
