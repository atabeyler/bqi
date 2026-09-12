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

export async function gatherResearchContext(category, topic, depth = 'standart', classification = null) {
  // 'hizli' (see routes/analysis.js's depth setting) skips the network
  // round-trip entirely instead of just formatting an empty result, since
  // the whole point of the fast tier is not waiting on web search.
  if (depth === 'hizli') return '';
  if (classification && WEB_RESEARCH_BLOCKED_CLASSIFICATIONS.has(String(classification).toUpperCase())) {
    logger.info({ classification }, '[WebResearch] Skipped: classification above PUBLIC/INTERNAL');
    return '';
  }

  const group = getCategoryGroup(category);
  const sources = CATEGORY_GROUP_SOURCES[group];
  const siteFilter = [...sources.local, ...sources.international].map((d) => `site:${d}`).join(' OR ');
  const topicQuery = (topic || '').slice(0, 150);

  const queries = [topicQuery, siteFilter ? `${topicQuery} mevzuat kanun yönetmelik ${siteFilter}` : null].filter(Boolean);

  try {
    const results = (await Promise.all(queries.map((q) => researchWeb(q).catch(() => [])))).flat();
    return formatResearchContext(results);
  } catch (e) {
    logger.warn({ err: e }, '[WebResearch] generate search error');
    return '';
  }
}
