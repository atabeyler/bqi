import { logger } from '../lib/logger.js';

function stripHtml(s = '') {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Titles and snippets are extracted independently (not by slicing out each
// result's own HTML block first) and paired up by position. A per-result
// block regex was tried first (bounded by the next `</div></div>` pair) but
// DuckDuckGo's actual markup closes `result__extras__url`/`result__extras`
// -- both `<div>`s -- well before the snippet, which lives in a sibling
// `<a class="result__snippet">` (or, for some result types, a sibling
// `<div>`) right after. That `</div>\s*</div>` pair matched the lazy block
// boundary first, so every chunk got truncated before reaching the snippet
// at all -- titles/URLs kept working (they come first), but `snippet` was
// silently '' for every single result (confirmed against real fetched DDG
// HTML: 10/10 results, 10/10 empty snippets). DuckDuckGo returns results in
// a fixed title-then-snippet order with one snippet per title, so pairing
// by index sidesteps the whole block-boundary problem instead of trying to
// find a more precise one.
export function parseDuckDuckGoHtml(html) {
  const titles = [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const snippets = [...html.matchAll(/<(a|div)[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/\1>/gi)];
  const out = [];
  for (let i = 0; i < titles.length && out.length < 6; i++) {
    const rawUrl = titles[i][1];
    const title = stripHtml(titles[i][2]);
    const snippet = snippets[i] ? stripHtml(snippets[i][2]) : '';
    if (!title || !rawUrl) continue;
    out.push({ title, url: rawUrl, snippet });
  }
  return out;
}

function decodeXml(s = '') {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// Google News RSS fallback. DuckDuckGo's HTML endpoint times out from
// Render's datacenter egress IPs (confirmed in production logs: both
// queries of a report hit the 8s AbortSignal), so a report was generated
// with no web grounding at all. The RSS feed is a plain public endpoint
// that answers from datacenter IPs and is already news-shaped.
export function parseGoogleNewsRss(xml, max = 15) {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  const out = [];
  for (const m of items) {
    if (out.length >= max) break;
    const block = m[1];
    const title = stripHtml(decodeXml((block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || ''));
    const url = decodeXml((block.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || '').trim();
    const desc = stripHtml(decodeXml((block.match(/<description>([\s\S]*?)<\/description>/i) || [])[1] || ''));
    const source = stripHtml(decodeXml((block.match(/<source[^>]*>([\s\S]*?)<\/source>/i) || [])[1] || ''));
    const pub = ((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1] || '').trim().slice(5, 16);
    if (!title || !url) continue;
    out.push({ title, url, snippet: `${pub ? `[${pub}] ` : ''}${source ? `${source}: ${desc}` : desc}`.slice(0, 300) });
  }
  return out;
}

async function fetchGoogleNews(q) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=tr&gl=TR&ceid=TR:tr`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 BQI/1.0', 'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`news HTTP ${res.status}`);
  return parseGoogleNewsRss(await res.text());
}

// Reports are about what is happening NOW, but an unrestricted news query is
// relevance-ranked and mixes in unrelated older/off-topic items (a real
// "fon dolandırıcılığı" query returned unrelated court/politics headlines in
// its top results; with a 30-day window all top results were the actual
// scandal). Recent window first; fall back to unrestricted for evergreen
// topics (laws, regulations) where nothing recent exists. `site:`-steered
// queries target static official pages, so they are never time-limited.
async function researchGoogleNews(q) {
  if (/\b(site|when):/i.test(q)) return fetchGoogleNews(q);
  const recent = await fetchGoogleNews(`${q} when:30d`);
  return recent.length >= 3 ? recent : fetchGoogleNews(q);
}

// Google News answers from datacenter IPs; DuckDuckGo's HTML endpoint times
// out from Render. News is therefore primary and DuckDuckGo only a
// supplement: when news already has enough results we return immediately
// instead of waiting out DuckDuckGo's timeout on every report.
const NEWS_SUFFICIENT = 4;

export async function researchWeb(query, limit = 12) {
  const q = (query || '').trim();
  if (!q) return [];
  const ddgPromise = researchDuckDuckGo(q);
  const newsPromise = researchGoogleNews(q);
  ddgPromise.catch(() => {}); // avoid unhandled rejection if we return before it settles
  let news = [];
  let newsErr = null;
  try {
    news = await newsPromise;
  } catch (e) {
    newsErr = e;
    logger.warn({ err: e?.message || String(e), query: q }, '[WebResearch] Google News failed');
  }
  let ddg = [];
  let ddgErr = null;
  if (news.length < NEWS_SUFFICIENT) {
    try {
      ddg = await ddgPromise;
    } catch (e) {
      ddgErr = e;
      logger.warn({ err: e?.message || String(e), query: q }, '[WebResearch] DuckDuckGo failed');
    }
  }
  if (newsErr && ddgErr) throw ddgErr;
  const seen = new Set();
  return [...news, ...ddg]
    .filter((r) => (seen.has(r.url) ? false : seen.add(r.url)))
    .slice(0, limit);
}

async function researchDuckDuckGo(q) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=tr-tr`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 BQI/1.0',
      'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
    },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`search HTTP ${res.status}`);
  const html = await res.text();
  const results = parseDuckDuckGoHtml(html);
  // A zero-result parse was previously silent and indistinguishable from
  // "genuinely no coverage of this topic" -- confirmed on a real report
  // ("Altura tankeri saldırısı" was a real, widely-covered event; BQI's own
  // report still said no source could be found). Logging the signals that
  // actually explain a parse miss (DDG redirected/blocked this request
  // entirely vs. the page came back but the result markup didn't match --
  // e.g. DDG changes its HTML structure, or serves a bot-check/consent
  // page instead of results, which happens disproportionately to
  // datacenter/cloud egress IPs like Render's) turns this from an
  // undiagnosable "the model said nothing was found" into something an
  // operator can actually act on.
  if (results.length === 0) {
    logger.warn({
      query: q,
      finalUrl: res.url,
      redirected: res.redirected,
      htmlLength: html.length,
    }, '[WebResearch] DuckDuckGo returned zero parsed results -- likely blocked/redirected or its HTML structure changed, not necessarily "no coverage"');
  }
  return results;
}

export function formatResearchContext(results) {
  if (!Array.isArray(results) || !results.length) return '';
  const lines = results.map((r, i) => `${i + 1}. ${r.title}\nURL: ${r.url}\nÖzet: ${r.snippet || '-'}`);
  return `[CANLI WEB ARAŞTIRMASI]\n${lines.join('\n\n')}\n`;
}

