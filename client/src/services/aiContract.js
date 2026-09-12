// Shared response shape for every AI answer the app can show, whichever
// engine actually produced it -- Q CLOUD (server/src/routes/analysis.js),
// Q LOCAL LLM (desktop/localAI or client/src/mobile/localAI's local-llm
// provider), or Q LOCAL DATA (the offline-extractive provider, unchanged).
// AnalysisView.jsx and ConsultChat.jsx render off of this shape instead of
// branching per-provider, per task spec point 7.
export const ENGINE = Object.freeze({
  CLOUD: 'cloud',
  LOCAL_LLM: 'local-llm',
  LOCAL_DATA: 'local-data',
});

// { engine, title, content, sources, provenance:{...cloud-only extras} }
// `content` is always markdown-renderable text (ReactMarkdown is already
// used for both AnalysisView's result and ConsultChat's messages).
// `sources` is an optional [{id, title}] list of local reports the local
// engines cite -- cloud responses don't carry this since server-side RAG
// isn't in scope here.
// `raw` keeps the original provider-specific response around (docx/pdf
// base64, quantum/fraud/optimizer sections, public engine label, ...) so
// nothing that already worked for the cloud path is lost -- callers that
// need those extras (downloadDocx, ResultSourceBadge, ...) read `raw`,
// while the parts every engine needs to render generically stay top-level.
export function normalizeCloudAnalysis(cloudResult) {
  return {
    engine: ENGINE.CLOUD,
    title: cloudResult?.title,
    content: cloudResult?.content,
    sources: [],
    providerLabel: 'Q CLOUD',
    raw: cloudResult,
  };
}

export function normalizeLocalLLMAnalysis(localResponse) {
  const result = localResponse?.result || {};
  return {
    engine: ENGINE.LOCAL_LLM,
    title: result.title,
    content: result.content,
    sources: result.sources || [],
    providerLabel: 'Q LOCAL',
    raw: localResponse,
  };
}

// Extractive fallback for a "generate" request never fabricates new
// prose (see offlineExtractive.js's synthesizeFromArchive) -- content is
// composed here, honestly, from the matched reports' own extractive
// summaries, clearly distinguishable from a real generated analysis.
export function normalizeLocalDataAnalysis(localResponse) {
  const synthesis = localResponse?.result || {};
  const matches = synthesis.matches || [];
  const content = matches.length
    ? [
        `_${synthesis.note}_`,
        ...matches.map((m) => `**${m.title}** _(${m.category}, ${new Date(m.createdAt).toLocaleDateString()})_\n${m.summary}`),
      ].join('\n\n')
    : `_${synthesis.note || 'Sonuç bulunamadı.'}_`;
  return {
    engine: ENGINE.LOCAL_DATA,
    title: 'Yerel arşiv sonucu',
    content,
    sources: matches.map((m) => ({ id: m.id, title: m.title })),
    providerLabel: 'Q LOCAL DATA',
    raw: localResponse,
  };
}

// ConsultChat's chat-shaped responses (find/summary/compare from
// offline-extractive, or free prose from local-llm) go through this
// instead -- kept separate from the analysis-generation normalizers above
// since the source shapes genuinely differ (a chat turn vs. a full report).
export function normalizeLocalChat(localResponse) {
  if (!localResponse?.ok) {
    return { engine: localResponse?.capability === 'local-llm' ? ENGINE.LOCAL_LLM : ENGINE.LOCAL_DATA, content: null, error: localResponse?.error, ok: false };
  }
  const engine = localResponse.capability === 'local-llm' ? ENGINE.LOCAL_LLM : ENGINE.LOCAL_DATA;
  if (localResponse.type === 'generated') {
    return { engine, ok: true, content: localResponse.text, sources: localResponse.sources || [], structured: null };
  }
  // find/summary/compare -- structured, rendered by the caller's existing
  // formatLocalAIResult()-style logic (kept, not replaced, in ConsultChat).
  return { engine, ok: true, content: null, sources: [], structured: { type: localResponse.type, result: localResponse.result } };
}
