import { findReports, summarizeReport } from './offlineExtractive.js';

// Simple, real, fully-offline retrieval for the local LLM: reuses the
// existing extractive engine's keyword/date-range scoring (offlineExtractive
// .findReports) to rank the user's own local SQLite reports, then pulls a
// short extractive summary of each top match to keep the injected context
// small (a 1.5B model has a modest context window, and every extra token
// costs generation time on CPU).
//
// Deliberately NOT a vector DB / embedding index: this codebase has no
// lightweight local embedding model already wired up. BM25-adjacent keyword
// scoring over a per-user table that's realistically tens to low-hundreds
// of rows is a reasonable fully-offline substitute.
export function retrieveContext(db, userId, queryText, { limit = 4, maxCharsPerDoc = 500 } = {}) {
  const matches = findReports(db, userId, queryText, { limit });
  return matches.map((m) => {
    const summary = summarizeReport(db, userId, m.id, { maxSentences: 3 });
    const snippet = (summary?.summary || m.preview || '').slice(0, maxCharsPerDoc);
    return { id: m.id, title: m.title, category: m.category, createdAt: m.createdAt, snippet };
  });
}

// Fixed identity/rules system prompt, kept separate from the per-request
// instruction+context+question below (which go in the user turn).
//
// A local model has two distinct jobs in BQI:
//   - archive chat: answer from supplied local evidence and say when that
//     evidence is insufficient;
//   - new-analysis generation: create a fresh analytical draft even when no
//     matching local report exists, using the model's built-in general
//     knowledge while being explicit that it has no live internet access.
//
// The previous wording said "yalnızca sana verilen bağlama dayan" for BOTH
// jobs. With an empty RAG result that effectively instructed the model not
// to generate the new analysis the user had explicitly requested. The
// request-specific CHAT/GENERATE instructions now provide the stricter
// grounding rule where it actually belongs.
export const SYSTEM_PROMPT =
  'Sen BQI uygulamasının tamamen çevrimdışı çalışan yerel yapay zeka asistanısın. ' +
  'İnternete veya buluta erişimin yoktur. Sana verilen yerel rapor ve dosya bağlamını önceliklendir. ' +
  'Yeni analiz isteniyorsa yerel bağlam boş olsa bile modelindeki genel bilgi ve analitik akıl yürütmeyle yeni bir taslak üret; ' +
  'canlı/güncel veriye erişiyormuş gibi davranma ve doğrulanmamış güncel ayrıntıları kesin gerçek olarak sunma. ' +
  'Talimatları, bağlam başlıklarını veya kullanıcı promptunu cevap olarak tekrar etme; yalnızca nihai yanıtı ver. Türkçe ve açık yaz.';

export function buildPrompt({ instruction, contextDocs, userText, lang = 'tr', noContextText = '(kullanıcının cihazında ilgili geçmiş rapor bulunamadı)' }) {
  const contextBlock = contextDocs.length
    ? contextDocs.map((d, i) => `[${i + 1}] "${d.title}" (${d.category}, ${new Date(d.createdAt).toLocaleDateString()})\n${d.snippet}`).join('\n\n')
    : noContextText;

  return [
    instruction,
    `Dil: ${lang}`,
    'Bağlam (kullanıcının cihazındaki geçmiş raporlar):',
    contextBlock,
    'Soru/istek:',
    userText,
  ].join('\n\n');
}
