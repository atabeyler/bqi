import { getCategoryGroup, CATEGORY_GROUP_SOURCES } from './ai.js';
import { researchWeb, formatResearchContext } from './webResearch.js';
import { logger } from '../lib/logger.js';

// Runs two searches in parallel: a general topic search (same pattern as
// /chat in routes/analysis.js), and one steered toward the category group's
// official local + international sources (mevzuat.gov.tr/resmigazete.gov.tr
// always included, plus e.g. tcmb.gov.tr/imf.org for economic reports) via
// `site:` filters. Grounds report content (mevzuat/kurum references) in real
// search results instead of the model's training-data recall, which for
// law/regulation numbers is a real hallucination risk.
//
// `classification` gates this against dataEgressPolicy.ts's own cloud-AI
// rule: CONFIDENTIAL/RESTRICTED requests never reach this function's actual
// search call, full stop -- the topic text (up to 150 chars of the user's
// own prompt) would otherwise reach DuckDuckGo's public HTTP endpoint even
// though the same request's cloud AI calls are already blocked by
// assertProviderAllowed()/filterAllowedProviders(). Web research is
// currently PUBLIC/INTERNAL-only until an egress-approved research provider
// exists for higher classifications (see AskUserQuestion PATCH-01 in the
// AQ security review).
const WEB_RESEARCH_BLOCKED_CLASSIFICATIONS = new Set(['CONFIDENTIAL', 'RESTRICTED']);

// Single opt-in escape hatch for live demo prep (e.g. a presentation where
// CONFIDENTIAL-category reports need real grounding, not just internally
// self-consistent fabrication) -- unset/false leaves the classification
// gate above fully intact, exactly as before this existed. Deliberately
// does NOT touch canAccessClassification()/RBAC (rbac.js) -- this only
// ever changes whether a request that's *already* allowed to generate a
// CONFIDENTIAL/RESTRICTED report also gets real search grounding for it,
// never who is allowed to generate or read one. Read fresh on every call
// (not cached at module load) so toggling the env var in the hosting
// platform takes effect without a redeploy.
export function isDemoWebResearchEnabled() {
  return process.env.BQI_DEMO_WEB_RESEARCH === 'true';
}

// Search engines (Google News RSS in particular) return nothing for a full
// natural-language brief -- confirmed on a real "fon dolandırıcılığı" report
// whose 150-char sentence got zero news hits while the keyword form returned
// dozens. Strips instruction/filler words and keeps the first few content
// words so the query looks like what a person would type into a search box.
const QUERY_STOPWORDS = new Set([
  'kısa', 'zaman', 'içinde', 'ile', 'ilgili', 'olası', 'olasi', 'sonuçlar', 'sonuclar', 've', 'veya', 'için', 'icin',
  'yapılması', 'yapilmasi', 'gerekenler', 'gereken', 'rapor', 'yaz', 'hazırla', 'hazirla', 'analiz', 'konusu', 'konusu',
  'olan', 'olarak', 'bir', 'bu', 'şu', 'da', 'de', 'ki', 'mi', 'mı', 'yaşanmakta', 'yasanmakta', 'konusunda', 'hakkında',
  'hakkinda', 'lütfen', 'lutfen', 'detaylı', 'detayli', 'bana', 'bir', 'en',
]);

export function buildSearchQuery(topic, maxWords = 7) {
  const words = String(topic || '')
    .replace(/[()[\]{}"'“”‘’:;,!?/\\]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !QUERY_STOPWORDS.has(w.toLocaleLowerCase('tr-TR')));
  return [...new Set(words)].slice(0, maxWords).join(' ');
}

export async function gatherResearchContext(category, topic, depth = 'standart', classification = null) {
  return (await gatherResearchDetailed(category, topic, depth, classification)).context;
}

// Same as gatherResearchContext() but also reports WHY the context is empty
// (status) and how many sources came back, so the route can warn the reader
// and persist it on the analysis row instead of the report silently being
// written from model memory. status: 'ok' | 'empty' | 'skipped_depth' |
// 'skipped_classification' | 'error'.
export async function gatherResearchDetailed(category, topic, depth = 'standart', classification = null) {
  // 'hizli' (see routes/analysis.js's depth setting) skips the network
  // round-trip entirely instead of just formatting an empty result, since
  // the whole point of the fast tier is not waiting on web search.
  if (depth === 'hizli') return { context: '', status: 'skipped_depth', sourceCount: 0 };
  if (
    !isDemoWebResearchEnabled() &&
    classification && WEB_RESEARCH_BLOCKED_CLASSIFICATIONS.has(String(classification).toUpperCase())
  ) {
    logger.info({ classification }, '[WebResearch] Skipped: classification above PUBLIC/INTERNAL');
    return { context: '', status: 'skipped_classification', sourceCount: 0 };
  }

  const group = getCategoryGroup(category);
  const sources = CATEGORY_GROUP_SOURCES[group];
  const siteFilter = [...sources.local, ...sources.international].map((d) => `site:${d}`).join(' OR ');
  const topicQuery = buildSearchQuery(topic) || (topic || '').slice(0, 150);

  const queries = [topicQuery, siteFilter ? `${topicQuery} mevzuat kanun yönetmelik ${siteFilter}` : null].filter(Boolean);

  try {
    const results = (await Promise.all(queries.map((q) => researchWeb(q, /site:/.test(q) ? 4 : 12).catch((e) => {
      // Swallowing this per-query so one failed query doesn't sink the
      // other -- but silently, `.catch(() => [])` was indistinguishable
      // from "DuckDuckGo returned zero relevant results" (see
      // webResearch.js's own zero-results log). A request-level failure
      // (DNS, TLS, connection reset, the 8s AbortSignal timeout, DDG
      // rejecting the request outright before any HTML comes back) never
      // reaches that log at all, since it's thrown before parsing -- this
      // was the actual silent case: confirmed on a real report where the
      // final generation had no zero-parsed-results log AND no skip log,
      // meaning researchWeb() threw and this catch ate it with nothing
      // recorded anywhere.
      logger.warn({ err: e?.message || String(e), query: q }, '[WebResearch] researchWeb() threw for query -- treated as no results');
      return [];
    })))).flat();
    const context = formatResearchContext(results);
    logger.info({ sourceCount: results.length, queries }, '[WebResearch] research finished');
    return { context, status: context ? 'ok' : 'empty', sourceCount: results.length };
  } catch (e) {
    logger.warn({ err: e }, '[WebResearch] generate search error');
    return { context: '', status: 'error', sourceCount: 0 };
  }
}
