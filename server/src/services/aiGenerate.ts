/**
 * BQI AI Generation Calls
 * Triple-provider fallback (Claude -> Gemini -> OpenAI) for one-shot
 * generation, vision, streaming consultation, and structured voice-intent
 * parsing. Split out of ai.ts, which mixed this call-flow logic with
 * provider client setup and system-prompt construction.
 */
import { generateText, generateObject, streamText } from 'ai';
import { z } from 'zod';
import type { Response } from 'express';
import { logger } from '../lib/logger.js';
import { recordRequestMetric } from '../lib/requestMetrics.js';
import { anthropicProvider, googleProvider, openaiProvider, MODELS, pickProviderOrder } from './aiProviders.js';
import { filterAllowedProviders, isCloudProviderAllowed, PolicyDenialError } from './dataEgressPolicy.js';

export { PolicyDenialError };

export const PUBLIC_CLOUD_PROVIDER_LABEL = 'Q CLOUD';

// Gemini failures are usually transient model-level overload (503), so every
// Gemini call site tries the primary model and then MODELS.geminiFallbacks
// (same provider, same egress-policy gate) before the next provider is used.
function geminiModelChain(): string[] {
  return [MODELS.gemini, ...MODELS.geminiFallbacks];
}

// item 18: a plain-text stream that just stops looks identical to the
// client whether it finished normally or was cut off mid-answer (a dropped
// connection, a provider erroring after the first chunk) -- there was no
// way to tell "the model said everything it had" from "the network died
// halfway through a sentence." These NUL-delimited markers are appended as
// the very last write before res.end() so the client (client/src/services/
// api.js's chatConsult) can strip them and know which case it was in. NUL
// is chosen because it cannot occur in normal model text output, so no
// real answer is ever mistaken for the marker.
const NUL = String.fromCharCode(0);
export const STREAM_END_MARKER = `${NUL}BQI_STREAM_END${NUL}`;
export const STREAM_ERROR_MARKER = `${NUL}BQI_STREAM_ERROR${NUL}`;

// Records latency + success/failure for one provider attempt, keyed
// `ai.<provider>` -- see getMetricsSnapshot()/the /api/platform/metrics
// endpoint. Comparing call counts across providers over time surfaces the
// Claude -> Gemini -> OpenAI fallback rate without a separate counter.
function recordAiAttempt(provider: string, startedAt: number, ok: boolean) {
  recordRequestMetric(`ai.${provider}`, Date.now() - startedAt, ok ? 200 : 500);
}

interface AttemptDef {
  name: string;
  model: any; // concrete model types differ per provider
}

interface GenerateResult {
  // Masked, UI-facing label ("Q CLOUD") -- what the client sees and what's
  // stored on the analyses row itself. Never the real vendor.
  provider: string;
  // AQ security review finding: the real provider identity (e.g. "Claude
  // (Anthropic)") used to be discarded entirely at this boundary -- every
  // caller only ever received/persisted the masked label above, including
  // decisionIntelligence.js's saveDecisionRecord(), whose own ai_provider/
  // model_name audit columns exist specifically to answer "which vendor
  // actually produced this analysis" and were silently getting "Q CLOUD"/
  // null in every row as a result. Callers that need the real identity for
  // audit/provenance purposes (never for the client response) read this
  // field instead.
  realProvider: string;
  content: string;
  usage: unknown;
}

// Thrown when every AI provider fails. The Turkish `message` is kept for
// logs and direct API callers, but the client never shows it raw -- it's
// not routed through the i18n system like the rest of the UI, so it would
// display in Turkish regardless of the user's selected app language. The
// `code` lets client code substitute a properly localized string instead
// (see AnalysisView.jsx / ConsultChat.jsx).
export class AllProvidersFailedError extends Error {
  code = 'ALL_AI_PROVIDERS_FAILED';
}

export async function generateAnalysisWithVision(
  systemPrompt: string,
  userPrompt: string,
  imageBase64: string,
  imageMimetype: string,
  classification: string = 'INTERNAL'
): Promise<GenerateResult> {
  if (anthropicProvider) {
    if (!isCloudProviderAllowed(classification, 'claude')) {
      logger.warn({ classification, provider: 'claude', route: 'generateAnalysisWithVision', reason: 'classification_forbids_cloud_provider' }, '[DataEgressPolicy] cloud AI provider call denied');
    } else {
      try {
        const { text, usage } = await generateText({
          model: anthropicProvider(MODELS.claudeText),
          system: systemPrompt,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', image: imageBase64, mediaType: imageMimetype },
                { type: 'text', text: userPrompt },
              ],
            },
          ],
          maxOutputTokens: 8000,
        });
        return { provider: PUBLIC_CLOUD_PROVIDER_LABEL, realProvider: 'Claude (Anthropic)', content: text, usage };
      } catch (err) {
        logger.warn({ err }, 'Claude Vision failed -> falling back to text');
      }
    }
  }
  // Text-only fallback still goes through generateAnalysis's own policy
  // gate below with the same classification -- vision being denied/failed
  // never implies the text fallback may skip the check.
  return generateAnalysis(systemPrompt, `[Görsel eklendi — görsel AI kullanılamıyor]\n\n${userPrompt}`, {}, classification);
}

// Per-provider call shape: Claude/OpenAI cap output and return real token
// usage; Gemini's Vercel AI SDK binding here doesn't take maxOutputTokens
// the same way and this call site doesn't surface its usage. Kept as a
// lookup table (keyed the same as PROVIDER_INFO in aiProviders.ts) so
// generateAnalysis below can loop over pickProviderOrder's policy-based
// ordering instead of three near-identical hardcoded if-blocks.
const PROVIDER_CALL: Record<string, { model: () => any; maxOutputTokens?: number }> = {
  claude: { model: () => anthropicProvider!(MODELS.claudeText), maxOutputTokens: 8000 },
  gemini: { model: () => googleProvider!(MODELS.gemini) },
  openai: { model: () => openaiProvider!.chat(MODELS.openai), maxOutputTokens: 8000 },
};

export async function generateAnalysis(
  systemPrompt: string,
  userPrompt: string,
  options: { maxOutputTokens?: number } = {},
  classification: string = 'INTERNAL'
): Promise<GenerateResult> {
  const errors: Array<{ provider: string; error: string }> = [];

  const candidates = pickProviderOrder(userPrompt.length);
  const allowed = filterAllowedProviders(classification, candidates, 'generateAnalysis');
  if (allowed.length === 0 && candidates.length > 0) {
    // Every configured/eligible provider was excluded by policy, not by an
    // actual call failure -- this must never look like AllProvidersFailedError
    // (which implies "the providers were tried and errored"), since a caller
    // (or the client UI) reacting to that would suggest retrying, when this
    // is a fail-closed policy decision that a retry can never satisfy.
    throw new PolicyDenialError(`Bu veri sınıfı (${classification}) için hiçbir cloud AI sağlayıcısına izin verilmiyor`);
  }

  for (const { key, name } of allowed) {
    const startedAt = Date.now();
    const call = PROVIDER_CALL[key];
    // An explicit override (see routes/analysis.js's depth setting) replaces
    // the provider's own default cap; otherwise each provider keeps its
    // existing default (Gemini's binding here takes no maxOutputTokens at
    // all -- see PROVIDER_CALL above).
    const maxOutputTokens = options.maxOutputTokens ?? call.maxOutputTokens;
    // Gemini is retried on its fallback models (same provider, same policy
    // gate) before moving on, since its failures are usually transient
    // model-level overload rather than a key/billing problem.
    const modelFactories: Array<() => any> = key === 'gemini'
      ? geminiModelChain().map((m) => () => googleProvider!(m))
      : [call.model];
    let lastErr: unknown;
    for (const makeModel of modelFactories) {
      try {
        const { text, usage } = await generateText({
          model: makeModel(),
          system: systemPrompt,
          prompt: userPrompt,
          ...(maxOutputTokens ? { maxOutputTokens } : {}),
          ...(key === 'gemini' ? { maxRetries: 1 } : {}),
        });
        recordAiAttempt(key, startedAt, true);
        return { provider: PUBLIC_CLOUD_PROVIDER_LABEL, realProvider: name, content: text, usage: usage ?? null };
      } catch (err) {
        lastErr = err;
        logger.warn({ err, provider: name }, 'AI provider model failed, trying next');
      }
    }
    recordAiAttempt(key, startedAt, false);
    errors.push({ provider: key, error: (lastErr as Error).message });
  }

  throw new AllProvidersFailedError(`Tüm AI sağlayıcılar başarısız: ${JSON.stringify(errors)}`);
}

/**
 * Real-time streaming for consultation chat. Providers are tried in order;
 * if a provider errors before producing its first chunk, the next one is
 * tried. Once writing has started (res.writeHead has been called), the
 * provider can no longer be switched — any error after that point ends the
 * stream where it is.
 */
export async function streamConsultationText(
  systemPrompt: string,
  userPrompt: string,
  res: Response,
  classification: string = 'INTERNAL'
): Promise<{ provider: string; realProvider: string; content: string }> {
  // Policy filter runs on plain {key,name} entries first -- the adapter
  // factory (anthropicProvider(...), which actually constructs an SDK model
  // handle) is only called afterward, for keys that survive the filter.
  // Building the model handle before filtering would call into the
  // provider adapter even for a denied provider, which is exactly what the
  // BQI-001/BQI-014 regression test (aiGenerate.test.ts) checks for.
  const keyCandidates: { key: string; name: string }[] = [
    anthropicProvider ? { key: 'claude', name: 'Claude (Anthropic)' } : null,
    googleProvider ? { key: 'gemini', name: 'Gemini (Google)' } : null,
    openaiProvider ? { key: 'openai', name: 'GPT-4o (OpenAI)' } : null,
  ].filter((x): x is { key: string; name: string } => x !== null);

  const allowedKeys = filterAllowedProviders(classification, keyCandidates, 'streamConsultationText');
  if (allowedKeys.length === 0 && keyCandidates.length > 0) {
    throw new PolicyDenialError(`Bu veri sınıfı (${classification}) için hiçbir cloud AI sağlayıcısına izin verilmiyor`);
  }

  const MODEL_FACTORY: Record<string, () => any> = {
    claude: () => anthropicProvider!(MODELS.claudeText),
    gemini: () => googleProvider!(MODELS.gemini),
    openai: () => openaiProvider!.chat(MODELS.openai),
  };
  const attempts: (AttemptDef & { key: string })[] = allowedKeys.flatMap(({ key, name }) =>
    key === 'gemini'
      ? geminiModelChain().map((m) => ({ key, name, model: googleProvider!(m) }))
      : [{ key, name, model: MODEL_FACTORY[key]() }]
  );

  for (const attempt of attempts) {
    const startedAt = Date.now();
    const metricKey = attempt.key;
    let startedSending = false;
    let full = '';
    try {
      const result = streamText({ model: attempt.model, system: systemPrompt, prompt: userPrompt, ...(attempt.key === 'gemini' ? { maxRetries: 1 } : {}) });
      for await (const chunk of result.textStream) {
        if (!startedSending) {
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'X-AI-Provider': encodeURIComponent(PUBLIC_CLOUD_PROVIDER_LABEL),
            'Cache-Control': 'no-cache',
          });
          startedSending = true;
        }
        full += chunk;
        res.write(chunk);
      }
      if (!startedSending) {
        // The stream completed with zero chunks and no thrown exception --
        // some providers (e.g. Anthropic on a billing/credit failure)
        // surface the error this way instead of rejecting the async
        // iterator. Without this check that looks like a silent, empty
        // "success" on the first attempt and never falls back to the next
        // provider, leaving the client with a 200 response and no body.
        recordAiAttempt(metricKey, startedAt, false);
        logger.warn({ provider: attempt.name }, 'Stream produced no output, trying next provider');
        continue;
      }
      recordAiAttempt(metricKey, startedAt, true);
      res.write(STREAM_END_MARKER);
      res.end();
      return { provider: PUBLIC_CLOUD_PROVIDER_LABEL, realProvider: attempt.name, content: full };
    } catch (err) {
      recordAiAttempt(metricKey, startedAt, false);
      if (startedSending) {
        // Data has already been sent to the client — no choice but to end the stream here.
        logger.warn({ err, provider: attempt.name }, 'Streaming cut short');
        res.write(STREAM_ERROR_MARKER);
        res.end();
        return { provider: PUBLIC_CLOUD_PROVIDER_LABEL, realProvider: attempt.name, content: full };
      }
      logger.warn({ err, provider: attempt.name }, 'Failed to start streaming, trying next provider');
    }
  }

  throw new AllProvidersFailedError('Tüm AI sağlayıcılar başarısız');
}

// Generic schema-constrained structured generation (Claude -> Gemini ->
// OpenAI, same policy-gated fallback as generateAnalysis), factored out of
// parseVoiceIntent's original hardcoded 3-provider pattern so other
// features (e.g. BQI-017's option/COA comparison) that need reliable JSON
// output don't have to duplicate it.
export interface StructuredGenerateResult<T> {
  object: T;
  realProvider: string;
}

// Same validated object generation as generateStructured(), with the real
// provider identity retained for audit/provenance-aware callers. Existing
// callers keep receiving the plain object through the compatibility wrapper
// below, so adding provenance does not change their contract.
export async function generateStructuredWithMetadata<T>(
  systemPrompt: string,
  userPrompt: string,
  schema: z.ZodType<T>,
  classification: string = 'INTERNAL',
  route = 'generateStructured'
): Promise<StructuredGenerateResult<T>> {
  const candidates = [
    anthropicProvider ? { key: 'claude', name: 'Claude (Anthropic)' } : null,
    googleProvider ? { key: 'gemini', name: 'Gemini (Google)' } : null,
    openaiProvider ? { key: 'openai', name: 'GPT-4o (OpenAI)' } : null,
  ].filter((x): x is { key: string; name: string } => x !== null);
  const allowed = filterAllowedProviders(classification, candidates, route);
  if (allowed.length === 0 && candidates.length > 0) {
    throw new PolicyDenialError(`Bu veri sınıfı (${classification}) için hiçbir cloud AI sağlayıcısına izin verilmiyor`);
  }

  const MODEL_FACTORY: Record<string, () => any> = {
    claude: () => anthropicProvider!(MODELS.claudeText),
    gemini: () => googleProvider!(MODELS.gemini),
    openai: () => openaiProvider!.chat(MODELS.openai),
  };

  for (const { key, name } of allowed) {
    const factories: Array<() => any> = key === 'gemini'
      ? geminiModelChain().map((m) => () => googleProvider!(m))
      : [MODEL_FACTORY[key]];
    for (const makeModel of factories) {
      try {
        const { object } = await generateObject({
          model: makeModel(), schema, system: systemPrompt, prompt: userPrompt,
          ...(key === 'gemini' ? { maxRetries: 1 } : {}),
        });
        return { object, realProvider: name };
      } catch (err) {
        logger.warn({ err, provider: key, route }, 'generateStructured: provider model failed, trying next');
      }
    }
  }

  throw new AllProvidersFailedError('Tüm AI sağlayıcılar başarısız');
}

export async function generateStructured<T>(
  systemPrompt: string,
  userPrompt: string,
  schema: z.ZodType<T>,
  classification: string = 'INTERNAL',
  route = 'generateStructured'
): Promise<T> {
  const result = await generateStructuredWithMetadata(systemPrompt, userPrompt, schema, classification, route);
  return result.object;
}

const voiceIntentSchema = z.object({
  actions: z.array(z.object({
    action: z.string(),
    params: z.record(z.string(), z.any()).optional().default({}),
  })),
  speak: z.string(),
});

export type VoiceIntentResult = z.infer<typeof voiceIntentSchema>;

// Uses generateObject (provider-native structured output) instead of free-text
// generation + manual JSON.parse -- the previous approach broke whenever a model
// wrapped its reply in prose/markdown or emitted an unescaped character, which
// made the voice assistant fall back to "could not understand" far too often.
export async function parseVoiceIntent(systemPrompt: string, userMessage: string, classification: string = 'INTERNAL'): Promise<VoiceIntentResult> {
  const attempted = { any: false };

  if (anthropicProvider) {
    if (isCloudProviderAllowed(classification, 'claude')) {
      attempted.any = true;
      try {
        const { object } = await generateObject({
          model: anthropicProvider(MODELS.claudeVoice),
          schema: voiceIntentSchema,
          system: systemPrompt,
          prompt: userMessage,
        });
        return object;
      } catch (err) {
        logger.warn({ err }, '[VoiceIntent] Claude failed, trying Gemini');
      }
    } else {
      logger.warn({ classification, provider: 'claude', route: 'parseVoiceIntent', reason: 'classification_forbids_cloud_provider' }, '[DataEgressPolicy] cloud AI provider call denied');
    }
  }

  if (googleProvider) {
    if (isCloudProviderAllowed(classification, 'gemini')) {
      attempted.any = true;
      for (const modelId of geminiModelChain()) {
        try {
          const { object } = await generateObject({
            model: googleProvider(modelId),
            schema: voiceIntentSchema,
            system: systemPrompt,
            prompt: userMessage,
            maxRetries: 1,
          });
          return object;
        } catch (err) {
          logger.warn({ err, model: modelId }, '[VoiceIntent] Gemini model failed, trying next');
        }
      }
    } else {
      logger.warn({ classification, provider: 'gemini', route: 'parseVoiceIntent', reason: 'classification_forbids_cloud_provider' }, '[DataEgressPolicy] cloud AI provider call denied');
    }
  }

  if (openaiProvider) {
    if (isCloudProviderAllowed(classification, 'openai')) {
      attempted.any = true;
      try {
        const { object } = await generateObject({
          model: openaiProvider.chat(MODELS.openai),
          schema: voiceIntentSchema,
          system: systemPrompt,
          prompt: userMessage,
        });
        return object;
      } catch (err) {
        logger.warn({ err }, '[VoiceIntent] GPT-4o also failed');
      }
    } else {
      logger.warn({ classification, provider: 'openai', route: 'parseVoiceIntent', reason: 'classification_forbids_cloud_provider' }, '[DataEgressPolicy] cloud AI provider call denied');
    }
  }

  if (!attempted.any && (anthropicProvider || googleProvider || openaiProvider)) {
    throw new PolicyDenialError(`Bu veri sınıfı (${classification}) için hiçbir cloud AI sağlayıcısına izin verilmiyor`);
  }

  // AllProvidersFailedError (not a plain Error) so callers that switch on
  // err.code === 'ALL_AI_PROVIDERS_FAILED' (client/src/services/api.js,
  // ConsultChat.jsx) also catch a total voice-intent failure consistently
  // with generateAnalysis/streamConsultationText above.
  throw new AllProvidersFailedError('Tüm AI sağlayıcılar başarısız');
}
