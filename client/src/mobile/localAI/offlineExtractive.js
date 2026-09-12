import { dbAll, dbGet } from '../db/index.js';
import { decryptField } from '../db/fieldCrypto.js';

// Fully offline "local AI" backend: keyword search, extractive
// summarization, and a bag-of-words comparison, all running directly
// against the local SQLite analyses table. No model download, no network
// call, no external dependency — this is what answers "geçen ayki
// raporlarımı bul", "bu ikisini karşılaştır", "özetle" while offline
// (spec point 7). Generating a brand new analysis is a different, far
// heavier capability (LLM + optionally the quantum kernel) that stays
// cloud-only via the existing /api/analysis endpoints — this module never
// tries to replace that. Ported from desktop/localAI/offlineExtractive.js
// to the async Capacitor SQLite API; the matching/scoring logic is
// identical.

const TR_MAP = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', İ: 'i' };

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[çğıöşüİ]/g, (c) => TR_MAP[c] || c)
    .replace(/[^a-z0-9\s]/g, ' ');
}

const STOPWORDS = new Set(['bir', 've', 'ile', 'bu', 'da', 'de', 'için', 'the', 'and', 'a', 'to', 'of', 'in']);

function tokenize(text) {
  return normalize(text).split(/\s+/).filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function scoreDoc(row, terms) {
  if (!terms.length) return 0;
  const titleTokens = tokenize(row.title);
  const contentTokens = tokenize(row.content);
  let score = 0;
  for (const term of terms) {
    score += titleTokens.filter((t) => t === term).length * 3;
    score += contentTokens.filter((t) => t === term).length;
  }
  return score;
}

async function decryptAnalysisRow(row) {
  if (!row) return row;
  return {
    ...row,
    title: await decryptField(row.title),
    content: await decryptField(row.content),
  };
}

async function decryptAnalysisRows(rows) {
  return Promise.all(rows.map(decryptAnalysisRow));
}

// Recognizes a small set of Turkish relative-date phrases and returns a
// [since, until) window, or null if the query doesn't reference a date range.
function parseDateRange(text, now = new Date()) {
  const t = normalize(text);
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = startOfDay(now);

  // \w* after the stem so inflected forms (the same word with a suffix
  // attached: "ayki", "haftaki", "haftada", ...) still match, not just
  // the bare word.
  if (/\bbugun\w*\b/.test(t)) {
    return { since: today, until: new Date(today.getTime() + 86400000) };
  }
  if (/\bdun\w*\b/.test(t)) {
    const yest = new Date(today.getTime() - 86400000);
    return { since: yest, until: today };
  }
  if (/\bbu hafta\w*\b/.test(t)) {
    const dayOfWeek = (today.getDay() + 6) % 7; // Monday = 0
    const monday = new Date(today.getTime() - dayOfWeek * 86400000);
    return { since: monday, until: new Date(today.getTime() + 86400000) };
  }
  if (/\bgecen hafta\w*\b/.test(t)) {
    const dayOfWeek = (today.getDay() + 6) % 7;
    const thisMonday = new Date(today.getTime() - dayOfWeek * 86400000);
    const lastMonday = new Date(thisMonday.getTime() - 7 * 86400000);
    return { since: lastMonday, until: thisMonday };
  }
  if (/\bbu ay\w*\b/.test(t)) {
    return { since: new Date(now.getFullYear(), now.getMonth(), 1), until: new Date(now.getFullYear(), now.getMonth() + 1, 1) };
  }
  if (/\bgecen ay\w*\b/.test(t)) {
    return { since: new Date(now.getFullYear(), now.getMonth() - 1, 1), until: new Date(now.getFullYear(), now.getMonth(), 1) };
  }
  return null;
}

export async function findReports(db, userId, queryText, { limit = 10, category = '' } = {}) {
  const allRows = await decryptAnalysisRows(await dbAll(db, `SELECT * FROM analyses WHERE user_id = ? AND deleted_at IS NULL`, [userId]));
  // Category is a hard, structured relevance signal -- unlike a free-text
  // term overlap score, it can't be won by coincidence. Scoping to it here
  // (rather than only folding it into the free-text query, as callers used
  // to do) stops a long, unrelated-category report from outranking a
  // shorter genuinely relevant one just because it repeats generic terms
  // (see synthesizeFromArchive's comment for the incident this fixes).
  const rows = category ? allRows.filter((r) => r.category === category) : allRows;
  const terms = tokenize(queryText);
  const range = parseDateRange(queryText);

  const filtered = range
    ? rows.filter((r) => {
        const created = new Date(r.created_at);
        return created >= range.since && created < range.until;
      })
    : rows;

  // A recognized date phrase ("geçen ayki raporlarımı bul") already narrows
  // the set enough on its own -- the remaining query words (raporlarımı,
  // bul, ...) shouldn't also have to match the content for a hit to count,
  // or every date-range query with no other topical keyword would return
  // nothing.
  const scored = filtered
    .map((row) => ({ row, score: terms.length ? scoreDoc(row, terms) : 1 }))
    .filter((s) => range || s.score > 0)
    .sort((a, b) => b.score - a.score || new Date(b.row.created_at) - new Date(a.row.created_at))
    .slice(0, limit);

  return scored.map(({ row, score }) => ({
    id: row.id,
    title: row.title,
    category: row.category,
    createdAt: row.created_at,
    preview: (row.content || '').slice(0, 200),
    score,
  }));
}

// Naive but real extractive summary: scores each sentence by how many
// query-relevant (here: globally frequent) terms it contains, keeps the
// top N, and re-emits them in original order so the summary still reads
// coherently.
export async function summarizeReport(db, userId, id, { maxSentences = 3 } = {}) {
  const row = await decryptAnalysisRow(await dbGet(db, `SELECT * FROM analyses WHERE id = ? AND user_id = ? AND deleted_at IS NULL`, [id, userId]));
  if (!row) return null;

  const sentences = (row.content || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (sentences.length <= maxSentences) {
    return { id: row.id, title: row.title, summary: sentences.join(' ') };
  }

  const termFreq = new Map();
  for (const s of sentences) {
    for (const term of tokenize(s)) termFreq.set(term, (termFreq.get(term) || 0) + 1);
  }

  const ranked = sentences
    .map((sentence, index) => {
      const score = tokenize(sentence).reduce((sum, term) => sum + (termFreq.get(term) || 0), 0);
      return { sentence, index, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSentences)
    .sort((a, b) => a.index - b.index);

  return { id: row.id, title: row.title, summary: ranked.map((r) => r.sentence).join(' ') };
}

// Bag-of-words comparison between two reports — what terms are shared vs.
// unique to each, and the raw length delta. Not a semantic diff, but a real
// offline signal a user can act on ("bu iki rapor ne kadar örtüşüyor").
export async function compareReports(db, userId, idA, idB) {
  const rowA = await decryptAnalysisRow(await dbGet(db, `SELECT * FROM analyses WHERE id = ? AND user_id = ? AND deleted_at IS NULL`, [idA, userId]));
  const rowB = await decryptAnalysisRow(await dbGet(db, `SELECT * FROM analyses WHERE id = ? AND user_id = ? AND deleted_at IS NULL`, [idB, userId]));
  if (!rowA || !rowB) return null;

  const termsA = new Set(tokenize(rowA.content));
  const termsB = new Set(tokenize(rowB.content));
  const common = [...termsA].filter((t) => termsB.has(t));

  return {
    a: { id: rowA.id, title: rowA.title, createdAt: rowA.created_at, length: (rowA.content || '').length },
    b: { id: rowB.id, title: rowB.title, createdAt: rowB.created_at, length: (rowB.content || '').length },
    commonTermCount: common.length,
    onlyInA: [...termsA].filter((t) => !termsB.has(t)).slice(0, 20),
    onlyInB: [...termsB].filter((t) => !termsA.has(t)).slice(0, 20),
    similarity: termsA.size || termsB.size ? common.length / new Set([...termsA, ...termsB]).size : 0,
  };
}

// Single entrypoint the caller uses: dispatches on entityIds/text rather
// than trying to do full natural-language entity resolution, which an
// extractive offline engine can't reliably do.
export async function queryOffline(db, userId, { text = '', entityIds = [] } = {}) {
  if (entityIds.length === 2) {
    return { type: 'compare', result: await compareReports(db, userId, entityIds[0], entityIds[1]) };
  }
  if (entityIds.length === 1) {
    return { type: 'summary', result: await summarizeReport(db, userId, entityIds[0]) };
  }
  return { type: 'find', result: await findReports(db, userId, text) };
}

// Mirrors desktop/localAI/offlineExtractive.js's synthesizeFromArchive --
// see that module's comment for why this deliberately does not fabricate a
// new AI-written report.
export async function synthesizeFromArchive(db, userId, { category = '', prompt = '' } = {}) {
  // Try the same category first: term-frequency scoring alone let a long,
  // categorically unrelated report (an old test fixture repeating generic
  // words like "bölge"/"güvenlik"/"risk") outscore and displace the
  // genuinely relevant same-category report it should have lost to.
  // Only widen to every category (the old behavior, category folded into
  // the free-text query) when nothing in the request's own category
  // exists at all, so this fallback still tries to help rather than going
  // straight to "nothing found".
  const scopedMatches = category ? await findReports(db, userId, prompt, { limit: 5, category }) : [];
  const matches = scopedMatches.length
    ? scopedMatches
    : await findReports(db, userId, `${category} ${prompt}`.trim(), { limit: 5 });
  const summaries = [];
  for (const m of matches) {
    const summary = await summarizeReport(db, userId, m.id, { maxSentences: 2 });
    summaries.push({ ...m, summary: summary?.summary || m.preview });
  }
  return {
    generated: false,
    matches: summaries,
    note: summaries.length
      ? 'Yerel arşivdeki en yakın eşleşen raporlar (yeni bir analiz üretilmedi).'
      : 'Yerel arşivde eşleşen rapor bulunamadı; yeni analiz üretimi için çevrimiçi bağlantı veya yerel LLM gerekir.',
  };
}

export const _internal = { tokenize, parseDateRange, scoreDoc };
