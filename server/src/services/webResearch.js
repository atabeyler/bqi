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

export async function researchWeb(query) {
  const q = (query || '').trim();
  if (!q) return [];
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=tr-tr`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 BQI/1.0',
      'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
    },
    signal: AbortSignal.timeout(8000),
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

