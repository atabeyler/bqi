import { config } from '../../config.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.BCI_AI_MODEL || 'claude-haiku-4-5-20251001';

// EXTERNAL_AI provider. Only ever called with text that's already been
// through src/ai/dlp.js -- this module doesn't redact anything itself, by
// design, so there is exactly one place in the codebase responsible for
// that and it's easy to audit.
export const anthropicProvider = {
  id: 'anthropic',
  mode: 'EXTERNAL_AI',

  // Doesn't spend a real request on every health check (this would be
  // called far more often than it's useful to bill for) -- key presence is
  // the practical signal; a real transport failure still surfaces through
  // generate() itself, which callers already handle.
  async healthCheck() {
    if (!config.anthropicApiKey) {
      return { status: 'OFFLINE', detail: 'BCI_ANTHROPIC_API_KEY not configured' };
    }
    return { status: 'HEALTHY', detail: `configured for model ${MODEL}` };
  },

  async generate({ prompt, maxTokens = 512 }) {
    if (!config.anthropicApiKey) throw new Error('BCI_ANTHROPIC_API_KEY not configured');

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      throw new Error(`Anthropic API error: HTTP ${res.status}`);
    }
    const body = await res.json();
    return { text: body.content?.[0]?.text ?? '' };
  },
};
