import { selectProvider, PROVIDERS } from './registry.js';

// The local AI "provider" tries the registry's providers in preference
// order (see registry.js's PROVIDERS list) and falls through automatically
// from local-llm to offline-extractive when the model turns out unusable
// for THIS request -- llmProvider.js throws the sentinel message
// 'local_llm_unavailable' specifically for that case (a device/model state
// that changed between selectProvider()'s cheap sync check and the actual
// call, e.g. the model file was removed mid-session). Any other error is
// NOT swallowed into a silent fallback -- it's surfaced as ok:false so a
// real bug in one engine never masquerades as "answered by another engine"
// (spec point 9: never silently pretend success).
//
// `.capability` on the returned object is the provider selectProvider()
// would pick right now (informational / for logging); the response from
// query() always carries its own `capability`, which is the engine that
// ACTUALLY produced that specific answer -- callers (the Analysis Router,
// the UI indicator) must read the per-response field, not this one, since
// they can differ when a fallback happened.
export function createLocalAIProvider({ db, userId, diagnostics }) {
  const provider = selectProvider();
  return {
    capability: provider.capability,
    async query(request) {
      const startIndex = PROVIDERS.findIndex((p) => p.capability === provider.capability);
      const candidates = PROVIDERS.slice(Math.max(startIndex, 0)).filter((p) => p.isAvailable());
      // selectProvider() itself is always in the candidate list (its own
      // isAvailable() just returned true), so candidates is never empty.

      // Only mode/depth/category -- enum-like control fields, never the
      // free-text title/prompt/content the user actually typed (those stay
      // out of the log even though redact() would also catch `title`/
      // `content` by key name; category/depth/mode were never in that risk
      // category to begin with). Logged so a support request ("it hung")
      // has a real start timestamp to diff against the eventual
      // success/failure line's elapsedMs -- previously the only way to
      // judge how long an attempt actually ran was to guess from unrelated
      // background log lines (sync/update-check) either side of it.
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
          // Any local-model failure is recoverable here for a chat/archive
          // request -- integrity errors, missing native bindings and load
          // failures must not disable the model-free archive engine that
          // can still answer safely. A 'generate' request is the one
          // exception: registry.js's offline-extractive createQuery
          // unconditionally throws offline_generation_unavailable for
          // mode==='generate' (a new-analysis request must never silently
          // become an old-report synthesis -- see that file's comment), so
          // falling through here can never succeed for it. Continuing
          // anyway just replaces a diagnosable local-llm error --
          // local_llm_timeout, local_llm_integrity_check_failed, a missing
          // node-llama-cpp native module, etc. -- with the same generic
          // offline_generation_unavailable every time, discarding the one
          // piece of information (which specific failure) a user or
          // support request actually needs. The real cause still reaches
          // the log either way, via the warn/error line below.
          const isRecoverableLLMFailure = current.capability === 'local-llm';
          const fallbackCanSucceed = request?.mode !== 'generate';
          if (isRecoverableLLMFailure && !isLast && fallbackCanSucceed) {
            diagnostics?.warn?.('local_llm_fallback', { message: err.message, elapsedMs: Date.now() - startedAt });
            continue; // try the next provider (offline-extractive)
          }
          // Never throws past this boundary (spec: a missing/broken local
          // AI backend must not crash the app) — reported as a capability
          // flag instead, so the renderer can show "yerel AI şu anda
          // kullanılamıyor" rather than an unhandled error. err.message
          // only, never the request/response content itself (may contain
          // report text).
          diagnostics?.error('local_ai_failure', { message: err.message, capability: current.capability, elapsedMs: Date.now() - startedAt });
          return { ok: false, error: 'local_ai_unavailable', detail: err.message, capability: current.capability };
        }
      }
      return { ok: false, error: 'local_ai_unavailable', detail: 'no_provider_available' };
    },
  };
}
