import { ENGINE, normalizeCloudAnalysis, normalizeLocalLLMAnalysis, normalizeLocalChat } from './aiContract.js';

// The single place implementing the priority chain from the task spec:
//   1. Cloud reachable        -> Q CLOUD (existing behavior, unchanged)
//   2. Cloud unreachable      -> Q LOCAL LLM (new)
//   3. Local LLM unavailable  -> existing extractive Q LOCAL DATA, but only
//                                for chat/consult requests. A "generate a
//                                new analysis" request has no offline-
//                                extractive fallback (see registry.js's
//                                offline-extractive createQuery) -- it
//                                would otherwise read as a genuine analysis
//                                of the requested topic while actually
//                                being a synthesis of unrelated old
//                                reports.
//   4. Nothing available      -> a clear, honest error (never silently
//                                pretend success)
//
// AnalysisView.jsx and ConsultChat.jsx both call this instead of talking
// to api.js or nativeAI directly, so there is exactly one fallback
// implementation instead of one per UI caller (task spec point 4).
//
// `isOffline` is the same boolean both callers already compute today
// (isNativeApp && connectivity === 'local') -- passed in rather than
// recomputed here so this module has no React/nativeBridge dependency of
// its own and stays trivially unit-testable.
export class AllEnginesUnavailableError extends Error {
  constructor(message = 'Hiçbir AI motoru şu anda kullanılamıyor.') {
    super(message);
    this.code = 'ALL_ENGINES_UNAVAILABLE';
  }
}

// request must be able to route into nativeAI.query({ mode: 'generate', ... }):
// see desktop/localAI/llmProvider.js and client/src/mobile/localAI/llmProvider.js
// for what that request shape supports.
export async function routeAnalysisGeneration({ isOffline, cloudCall, nativeAIQuery, generateRequest }) {
  if (!isOffline) {
    // Cloud remains the default path. If it fails while the health monitor
    // still says online, continue locally so a freshly dropped connection
    // does not lose the user's completed analysis form.
    try {
      const cloudResult = await cloudCall();
      return normalizeCloudAnalysis(cloudResult);
    } catch (cloudError) {
      if (!nativeAIQuery) throw cloudError;
      // The health state may be stale; continue through the same local
      // chain so a dropped connection does not discard the user's form.
    }
  }

  if (!nativeAIQuery) throw new AllEnginesUnavailableError('nativeAIQuery_missing');

  const response = await nativeAIQuery({ mode: 'generate', ...generateRequest });
  // provider.js's `detail` (the underlying provider's own err.message, e.g.
  // 'no_provider_available' or a real native exception) is far more
  // specific than `error` (always one of two fixed strings) -- surfacing
  // it here is what actually made this failure mode diagnosable instead
  // of every local-AI failure showing identical, undiagnosable text.
  if (!response?.ok) {
    throw new AllEnginesUnavailableError([response?.error, response?.detail].filter(Boolean).join(': ') || undefined);
  }

  if (response.capability === 'local-llm') return normalizeLocalLLMAnalysis(response);
  // offline-extractive is a valid answer for routeConsultChat below, never
  // for a "new analysis" generation request -- registry.js's own
  // offline-extractive provider already refuses a mode:'generate' request
  // outright (this route always sends mode:'generate', see the
  // nativeAIQuery call above), so a response tagged offline-extractive
  // reaching here would mean that guard was bypassed. Treated the same as
  // "no engine available" rather than accepted, so a synthesis of
  // unrelated past reports can never be handed back as if it were a real
  // analysis of the requested topic.
  throw new AllEnginesUnavailableError(`unexpected_capability:${response.capability}`);
}

// Chat/consult variant: cloud path is the caller's existing streaming
// chatConsult() call (kept exactly as-is, including streaming callbacks);
// the offline path goes through the same local provider chain.
export async function routeConsultChat({ isOffline, cloudCall, nativeAIQuery, chatText, attachmentContext = '' }) {
  if (!isOffline) {
    try {
      const r = await cloudCall();
      return { engine: ENGINE.CLOUD, ok: true, content: r.content, providerLabel: 'Q CLOUD', raw: r };
    } catch (cloudError) {
      if (!nativeAIQuery) throw cloudError;
      // Connectivity can change between the 30-second health checks. Retry
      // the same request locally instead of making the user submit twice.
    }
  }
  if (!nativeAIQuery) throw new AllEnginesUnavailableError('nativeAIQuery_missing');
  const response = await nativeAIQuery({ mode: 'chat', text: chatText, attachmentContext });
  const normalized = normalizeLocalChat(response);
  if (!normalized.ok) throw new AllEnginesUnavailableError(normalized.error);
  return normalized;
}

export { ENGINE };
