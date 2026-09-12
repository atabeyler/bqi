import { describe, it, expect, vi, beforeEach } from 'vitest';

// BQI-001/BQI-014 regression test: for a RESTRICTED classification, none of
// the Claude/Gemini/OpenAI adapter factory functions may ever be invoked --
// mocking aiProviders.js's exports as spies lets this be proven directly
// (a real call would show up as one of these functions having been
// called), independent of which real API keys happen to be configured in
// whatever environment runs this test.
const claudeModelFactory = vi.fn((_modelId?: string) => ({ _tag: 'claude-model' }));
const geminiModelFactory = vi.fn((_modelId?: string) => ({ _tag: 'gemini-model' }));
const openaiChatFactory = vi.fn((_modelId?: string) => ({ _tag: 'openai-model' }));

vi.mock('./aiProviders.js', () => {
  const anthropicProvider = vi.fn((modelId: string) => claudeModelFactory(modelId));
  const googleProvider = vi.fn((modelId: string) => geminiModelFactory(modelId));
  const openaiProvider = { chat: vi.fn((modelId: string) => openaiChatFactory(modelId)) };
  return {
    anthropicProvider,
    googleProvider,
    openaiProvider,
    MODELS: { claudeText: 'claude-x', claudeVoice: 'claude-voice-x', gemini: 'gemini-x', openai: 'openai-x' },
    // All three "configured" and offered, in the fixed order -- this is
    // exactly the scenario a real deployment with all three API keys set
    // would produce, so a RESTRICTED request here is the strongest possible
    // test: policy is the *only* thing standing between the request and a
    // cloud provider.
    pickProviderOrder: vi.fn(() => [
      { key: 'claude', name: 'Claude (Anthropic)', contextWindowTokens: 200000, isConfigured: () => true },
      { key: 'gemini', name: 'Gemini (Google)', contextWindowTokens: 1000000, isConfigured: () => true },
      { key: 'openai', name: 'GPT-4o (OpenAI)', contextWindowTokens: 128000, isConfigured: () => true },
    ]),
  };
});

vi.mock('ai', () => ({
  generateText: vi.fn(async () => ({ text: 'should never run for RESTRICTED', usage: null })),
  generateObject: vi.fn(async () => ({ object: { actions: [], speak: 'should never run for RESTRICTED' } })),
  streamText: vi.fn(() => ({
    textStream: (async function* () { yield 'should never run for RESTRICTED'; })(),
  })),
}));

import {
  generateAnalysis,
  generateAnalysisWithVision,
  streamConsultationText,
  parseVoiceIntent,
  PolicyDenialError,
} from './aiGenerate.js';

function fakeRes() {
  const chunks: string[] = [];
  return {
    writeHead: vi.fn(),
    write: vi.fn((c: string) => chunks.push(c)),
    end: vi.fn(),
    headersSent: false,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.APPROVED_CLOUD_PROVIDERS;
});

describe('BQI-001/BQI-014: RESTRICTED classification never reaches a cloud AI adapter', () => {
  it('generateAnalysis: throws PolicyDenialError and never calls any provider factory', async () => {
    await expect(generateAnalysis('sys', 'user prompt', {}, 'RESTRICTED')).rejects.toThrow(PolicyDenialError);
    expect(claudeModelFactory).not.toHaveBeenCalled();
    expect(geminiModelFactory).not.toHaveBeenCalled();
    expect(openaiChatFactory).not.toHaveBeenCalled();
  });

  it('generateAnalysisWithVision: never calls Claude vision or any text-fallback provider', async () => {
    await expect(
      generateAnalysisWithVision('sys', 'user prompt', 'base64img', 'image/png', 'RESTRICTED')
    ).rejects.toThrow(PolicyDenialError);
    expect(claudeModelFactory).not.toHaveBeenCalled();
    expect(geminiModelFactory).not.toHaveBeenCalled();
    expect(openaiChatFactory).not.toHaveBeenCalled();
  });

  it('streamConsultationText: never writes headers or calls any provider factory', async () => {
    const res = fakeRes();
    await expect(streamConsultationText('sys', 'user prompt', res, 'RESTRICTED')).rejects.toThrow(PolicyDenialError);
    expect(claudeModelFactory).not.toHaveBeenCalled();
    expect(geminiModelFactory).not.toHaveBeenCalled();
    expect(openaiChatFactory).not.toHaveBeenCalled();
    expect(res.writeHead).not.toHaveBeenCalled();
  });

  it('parseVoiceIntent: never calls any provider factory', async () => {
    await expect(parseVoiceIntent('sys', 'user message', 'RESTRICTED')).rejects.toThrow();
    expect(claudeModelFactory).not.toHaveBeenCalled();
    expect(geminiModelFactory).not.toHaveBeenCalled();
    expect(openaiChatFactory).not.toHaveBeenCalled();
  });
});

describe('BQI-001/BQI-014: other classifications still reach the provider (policy is not fail-open in the other direction)', () => {
  it('PUBLIC: generateAnalysis calls the first (Claude) provider factory', async () => {
    const result = await generateAnalysis('sys', 'user prompt', {}, 'PUBLIC');
    expect(claudeModelFactory).toHaveBeenCalledTimes(1);
    expect(result.provider).toBe('Q CLOUD');
  });

  it('INTERNAL: generateAnalysis calls the first approved provider factory', async () => {
    await generateAnalysis('sys', 'user prompt', {}, 'INTERNAL');
    expect(claudeModelFactory).toHaveBeenCalledTimes(1);
  });

  it('INTERNAL restricted to a smaller approved-provider set via APPROVED_CLOUD_PROVIDERS skips the excluded ones', async () => {
    process.env.APPROVED_CLOUD_PROVIDERS = 'gemini';
    const result = await generateAnalysis('sys', 'user prompt', {}, 'INTERNAL');
    expect(claudeModelFactory).not.toHaveBeenCalled();
    expect(geminiModelFactory).toHaveBeenCalledTimes(1);
    expect(result.provider).toBe('Q CLOUD');
  });

  it('CONFIDENTIAL: generateAnalysis calls the first approved provider factory, same as INTERNAL', async () => {
    await generateAnalysis('sys', 'user prompt', {}, 'CONFIDENTIAL');
    expect(claudeModelFactory).toHaveBeenCalledTimes(1);
  });

  it('CONFIDENTIAL restricted to a smaller approved-provider set via APPROVED_CLOUD_PROVIDERS skips the excluded ones', async () => {
    process.env.APPROVED_CLOUD_PROVIDERS = 'gemini';
    await generateAnalysis('sys', 'user prompt', {}, 'CONFIDENTIAL');
    expect(claudeModelFactory).not.toHaveBeenCalled();
    expect(geminiModelFactory).toHaveBeenCalledTimes(1);
  });
});
