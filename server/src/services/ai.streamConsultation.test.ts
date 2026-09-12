import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression coverage for a real production bug: /api/analysis/chat
// (danisma consultation) returned an empty 200 response with no body,
// confirmed live. Root cause: Anthropic was failing (a billing/credit
// issue, separately confirmed elsewhere in this session) in a way that
// completes streamText()'s async iterator with zero chunks instead of
// throwing -- generateAnalysis() (used by the non-streaming /generate
// route) awaits the whole response and so throws cleanly on the same
// failure, but streamConsultationText() only fell back to the next
// provider on a thrown exception, so a silent empty stream looked like a
// successful (if empty) response and never reached Gemini/OpenAI.

const streamTextMock = vi.fn();

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, streamText: (...args: unknown[]) => streamTextMock(...args) };
});
vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: () => (model: string) => ({ provider: 'anthropic', model }),
}));
vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: () => (model: string) => ({ provider: 'google', model }),
}));
vi.mock('@ai-sdk/openai', () => {
  const factory = (model: string) => ({ provider: 'openai', model });
  factory.chat = (model: string) => ({ provider: 'openai-chat', model });
  return { createOpenAI: () => factory };
});

process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.OPENAI_API_KEY = 'test-openai-key';

const { streamConsultationText } = await import('./ai.js');

function emptyStream() {
  return { textStream: (async function* () {})() };
}
function chunkedStream(chunks: string[]) {
  return {
    textStream: (async function* () {
      for (const c of chunks) yield c;
    })(),
  };
}

function fakeRes() {
  return {
    headersSent: false,
    writeHead: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
  };
}

beforeEach(() => {
  streamTextMock.mockReset();
});

describe('streamConsultationText', () => {
  it('returns the first provider\'s streamed content when it produces output', async () => {
    streamTextMock.mockReturnValueOnce(chunkedStream(['Merhaba']));
    const res = fakeRes();
    const result = await streamConsultationText('sys', 'user', res as never);
    expect(result).toEqual({ provider: 'Q CLOUD', realProvider: 'Claude (Anthropic)', content: 'Merhaba' });
    expect(res.writeHead).toHaveBeenCalledTimes(1);
    // item 18: a completion marker must be written before the stream ends,
    // so the client can tell a clean finish apart from a mid-answer cutoff.
    expect(res.write).toHaveBeenLastCalledWith(expect.stringContaining('BQI_STREAM_END'));
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('falls back to the next provider when a stream completes with zero chunks and no thrown error', async () => {
    streamTextMock
      .mockReturnValueOnce(emptyStream()) // Claude: silent empty failure
      .mockReturnValueOnce(chunkedStream(['Merhaba', ' dünya']));
    const res = fakeRes();
    const result = await streamConsultationText('sys', 'user', res as never);
    expect(result).toEqual({ provider: 'Q CLOUD', realProvider: 'Gemini (Google)', content: 'Merhaba dünya' });
    // Only one writeHead call -- Claude's empty attempt must never have
    // started a response, or the client would see a truncated/empty body
    // before Gemini's real content.
    expect(res.writeHead).toHaveBeenCalledTimes(1);
    expect(res.write).toHaveBeenLastCalledWith(expect.stringContaining('BQI_STREAM_END'));
  });

  it('also falls back on a thrown exception (pre-existing behavior)', async () => {
    streamTextMock
      .mockImplementationOnce(() => { throw new Error('rate limited'); })
      .mockReturnValueOnce(chunkedStream(['Ok']));
    const res = fakeRes();
    const result = await streamConsultationText('sys', 'user', res as never);
    expect(result).toEqual({ provider: 'Q CLOUD', realProvider: 'Gemini (Google)', content: 'Ok' });
  });

  // item 18
  it('writes an error marker instead of an end marker when a provider errors mid-stream, after already sending data', async () => {
    streamTextMock.mockReturnValueOnce({
      textStream: (async function* () {
        yield 'Merha';
        throw new Error('connection dropped');
      })(),
    });
    const res = fakeRes();
    const result = await streamConsultationText('sys', 'user', res as never);
    expect(result).toEqual({ provider: 'Q CLOUD', realProvider: 'Claude (Anthropic)', content: 'Merha' });
    expect(res.write).toHaveBeenLastCalledWith(expect.stringContaining('BQI_STREAM_ERROR'));
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('throws when every provider fails or produces no output', async () => {
    streamTextMock.mockReturnValue(emptyStream());
    const res = fakeRes();
    await expect(streamConsultationText('sys', 'user', res as never)).rejects.toThrow('Tüm AI sağlayıcılar başarısız');
    expect(res.writeHead).not.toHaveBeenCalled();
  });

  it('tags the all-providers-failed error with a machine-readable code', async () => {
    // The message is Turkish-only and not routed through the client's i18n
    // system, so the route handler forwards this `code` in the JSON error
    // response and the client substitutes a properly localized string
    // instead of showing raw Turkish regardless of the user's UI language.
    streamTextMock.mockReturnValue(emptyStream());
    const res = fakeRes();
    await expect(streamConsultationText('sys', 'user', res as never)).rejects.toMatchObject({
      code: 'ALL_AI_PROVIDERS_FAILED',
    });
  });
});
