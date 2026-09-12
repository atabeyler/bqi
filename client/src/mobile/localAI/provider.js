import { selectProvider, _internal } from './registry.js';

// Mirrors desktop/localAI/provider.js's fallback behavior (see that
// module's comment for the full rationale): tries the selected provider,
// and if it's local-llm failing with a known-recoverable sentinel, falls
// through to offline-extractive within the same call instead of surfacing
// a broken "local LLM" answer to the UI. Any other (unexpected) error is
// surfaced as ok:false, never masked by a silent fallback, so a genuine
// bug in the local-llm path stays visible instead of being hidden behind
// a degraded archive answer.
//
// Every 'local_llm_*'-prefixed sentinel (llmProvider.js's own
// 'local_llm_unavailable' capability check, and LocalLLMPlugin.kt's own
// PluginCall.reject() strings -- 'local_llm_model_file_missing: ...',
// 'local_llm_native_load_failed'[': <native message>'],
// 'local_llm_generate_failed: ...') plus llmRuntime.js's
// 'android_native_llm_plugin_missing' are all expected, recoverable "the
// local LLM isn't usable right now" states, not bugs -- matched by prefix
// rather than an exact-string Set so a reject() message with an appended
// native detail (the ": <message>" suffix above) still recognizes as
// recoverable. Observed firsthand on a real device that a plugin call
// genuinely reaching the native side and failing there
// ('local_llm_native_load_failed', llama.cpp itself refusing the
// downloaded model) was NOT in an earlier version of this list -- so
// "Yeni Analiz" failed with no archive fallback at all despite the
// archive path being fully available. Anything NOT matching this prefix
// (a real JS bug, a malformed request, ...) still surfaces as ok:false
// rather than being silently masked.
function isRecoverableLocalLLMError(message) {
  return typeof message === 'string' && (message.startsWith('local_llm_') || message === 'android_native_llm_plugin_missing');
}

export function createLocalAIProvider({ db, userId, diagnostics }) {
  const provider = selectProvider();
  return {
    capability: provider.capability,
    async query(request) {
      const { PROVIDERS } = _internal;
      const startIndex = PROVIDERS.findIndex((p) => p.capability === provider.capability);
      const candidates = PROVIDERS.slice(Math.max(startIndex, 0)).filter((p) => p.isAvailable());

      // Mirrors desktop/localAI/provider.js's same addition: mode/depth/
      // category only, never the free-text title/prompt/content the user
      // actually typed. Logged so a support request ("it hung") has a real
      // start timestamp to diff against the eventual success/failure line's
      // elapsedMs -- previously the only way to judge how long an attempt
      // actually ran was to guess from unrelated background log lines
      // either side of it.
      const startedAt = Date.now();
      diagnostics?.info?.('local_ai_query_start', { mode: request?.mode, depth: request?.depth, category: request?.category });

      for (let i = 0; i < candidates.length; i++) {
        const current = candidates[i];
        const isLast = i === candidates.length - 1;
        try {
          const runQuery = current.createQuery({ db, userId });
          const result = await runQuery(request);
          diagnostics?.info?.('local_ai_query_success', { capability: current.capability, elapsedMs: Date.now() - startedAt });
          return { ok: true, capability: current.capability, ...result };
        } catch (err) {
          // registry.js's offline-extractive createQuery unconditionally
          // rejects mode==='generate' with offline_generation_unavailable
          // (a new-analysis request must never silently become an
          // old-report synthesis), so falling through to it after a
          // local-llm failure can never succeed for a generate request --
          // it only replaces a diagnosable native error
          // (local_llm_native_load_failed, local_llm_model_file_missing,
          // local_llm_generate_failed, android_native_llm_plugin_missing)
          // with the same generic offline_generation_unavailable in the
          // response the UI actually shows, discarding the one piece of
          // information (which specific failure) a user or support request
          // actually needs. Mirrors desktop/localAI/provider.js's same fix.
          const isRecoverableLLMFailure = current.capability === 'local-llm' && isRecoverableLocalLLMError(err.message);
          const fallbackCanSucceed = request?.mode !== 'generate';
          if (isRecoverableLLMFailure && !isLast && fallbackCanSucceed) {
            diagnostics?.warn?.('local_llm_fallback', { message: err.message, elapsedMs: Date.now() - startedAt });
            continue;
          }
          diagnostics?.error('local_ai_failure', { message: err.message, capability: current.capability, elapsedMs: Date.now() - startedAt });
          return { ok: false, error: 'local_ai_unavailable', detail: err.message, capability: current.capability };
        }
      }
      return { ok: false, error: 'local_ai_unavailable', detail: 'no_provider_available' };
    },
  };
}
