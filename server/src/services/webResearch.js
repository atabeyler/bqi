import { logger } from '../lib/logger.js';

function decodeNumericEntities(s = '') {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

function stripHtml(s = '') {
  return decodeNumericEntities(s)
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

// --- Bing News RSS -------------------------------------------------------
// Unlike Google News (opaque redirect tokens, and it serves a captcha page to
// datacenter IPs after a few requests), Bing's RSS carries the publisher's
// real URL in its `url=` parameter and a multi-sentence description, so
// articles can actually be fetched and read. `interval="9"` = past 30 days.
export function parseBingNewsRss(xml, max = 15) {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  const out = [];
  for (const m of items) {
    if (out.length >= max) break;
    const block = m[1];
    const title = stripHtml(decodeXml((block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || ''));
    const link = decodeXml((block.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || '').trim();
    let url = link;
    try {
      const real = new URL(link).searchParams.get('url');
      if (real) url = real;
    } catch { /* keep the raw link */ }
    const desc = stripHtml(decodeXml((block.match(/<description>([\s\S]*?)<\/description>/i) || [])[1] || ''));
    const source = stripHtml(decodeXml((block.match(/<News:Source>([\s\S]*?)<\/News:Source>/i) || [])[1] || ''));
    const pub = ((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1] || '').trim().slice(5, 16);
    if (!title || !url) continue;
    out.push({
      title,
      url,
      snippet: `${pub ? `[${pub}] ` : ''}${source ? `${source}: ` : ''}${desc}`.slice(0, 400),
    });
  }
  return out;
}

async function researchBingNews(q) {
  const url = `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&setlang=tr&cc=TR&qft=${encodeURIComponent('interval="9"')}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 BQI/1.0', 'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`bing news HTTP ${res.status}`);
  return parseBingNewsRss(await res.text());
}

// --- Article body extraction ---------------------------------------------
// Headlines alone gave reports the event's outline but none of its facts
// (amounts, counts, names, dates). Top results are fetched and their body
// text extracted so the model can cite real details. Only public http(s)
// pages are fetched (no IP literals / localhost / private ranges), with a
// short timeout and a hard size cap; any failure just leaves that result
// headline-only.
const ARTICLE_MAX_BYTES = 1_500_000;
const ARTICLE_MAX_CHARS = 2200;

function isFetchableArticleUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (/^[\d.]+$/.test(h) || h.includes(':')) return false; // IPv4/IPv6 literals
  if (/(^|\.)(news\.google\.com|bing\.com)$/.test(h)) return false; // redirectors, not articles
  return true;
}

export function extractArticleText(html) {
  const cleaned = html
    .replace(/<(script|style|noscript|nav|header|footer|aside|form|svg|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const scope = (cleaned.match(/<article[\s\S]*?<\/article>/i) || [cleaned])[0];
  const paras = [...scope.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => stripHtml(m[1]))
    .filter((t) => t.length > 60);
  let text = paras.join(' ');
  if (text.length < 200) {
    const og = (html.match(/<meta[^>]+(?:property|name)=["'](?:og:description|description)["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:description|description)["']/i) || [])[1];
    if (og) text = `${stripHtml(og)} ${text}`.trim();
  }
  return text.slice(0, ARTICLE_MAX_CHARS);
}

async function fetchArticleText(url) {
  if (!isFetchableArticleUrl(url)) return '';
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BQI/1.0)', 'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8', Accept: 'text/html' },
    redirect: 'follow',
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return '';
  if (!isFetchableArticleUrl(res.url)) return '';
  if (!/text\/html|application\/xhtml/i.test(res.headers.get('content-type') || '')) return '';
  const html = (await res.text()).slice(0, ARTICLE_MAX_BYTES);
  return extractArticleText(html);
}

// Tries more candidates than it keeps: some publishers block bots (e.g. BBC
// answers 403) and a failed fetch must not cost the report a source. Bodies
// are kept for the first `keep` successes in the original ranking order.
export async function enrichWithArticleText(results, { candidates = 10, keep = 6 } = {}) {
  const targets = results.filter((r) => isFetchableArticleUrl(r.url)).slice(0, candidates);
  const bodies = await Promise.all(targets.map(async (r) => {
    try {
      const body = await fetchArticleText(r.url);
      return body && body.length > 120 ? body : '';
    } catch (e) {
      logger.info({ url: r.url, err: e?.message || String(e) }, '[WebResearch] article fetch failed, keeping headline only');
      return '';
    }
  }));
  let kept = 0;
  targets.forEach((r, idx) => {
    if (bodies[idx] && kept < keep) { r.body = bodies[idx]; kept++; }
  });
  return results;
}

// Google News answers from datacenter IPs; DuckDuckGo's HTML endpoint times
// out from Render. News is therefore primary and DuckDuckGo only a
// supplement: when news already has enough results we return immediately
// instead of waiting out DuckDuckGo's timeout on every report.
const NEWS_SUFFICIENT = 4;

function sameStory(a, b) {
  const norm = (t) => t.toLowerCase().replace(/\s+-\s+[^-]+$/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return norm(a) === norm(b);
}

// opts.deep: also fetch and attach the body text of the top articles.
export async function researchWeb(query, limit = 12, opts = {}) {
  const q = (query || '').trim();
  if (!q) return [];
  const ddgPromise = researchDuckDuckGo(q);
  ddgPromise.catch(() => {}); // avoid unhandled rejection if we return before it settles
  const [bing, google] = await Promise.allSettled([researchBingNews(q), researchGoogleNews(q)]);
  const failures = [];
  for (const [name, r] of [['Bing News', bing], ['Google News', google]]) {
    if (r.status === 'rejected') {
      failures.push(r.reason);
      logger.warn({ err: r.reason?.message || String(r.reason), query: q }, `[WebResearch] ${name} failed`);
    }
  }
  // Bing first: its URLs are real article URLs (fetchable for deep mode).
  let merged = [...(bing.value || []), ...(google.value || [])];
  let ddgErr = null;
  if (merged.length < NEWS_SUFFICIENT) {
    try {
      merged = [...merged, ...(await ddgPromise)];
    } catch (e) {
      ddgErr = e;
      logger.warn({ err: e?.message || String(e), query: q }, '[WebResearch] DuckDuckGo failed');
    }
  }
  if (failures.length === 2 && ddgErr) throw ddgErr;
  const seenUrl = new Set();
  const out = [];
  for (const r of merged) {
    if (seenUrl.has(r.url) || out.some((o) => sameStory(o.title, r.title))) continue;
    seenUrl.add(r.url);
    out.push(r);
    if (out.length >= limit) break;
  }
  return opts.deep ? enrichWithArticleText(out) : out;
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
  const lines = results.map((r, i) => `${i + 1}. ${r.title}\nURL: ${r.url}\nÖzet: ${r.snippet || '-'}${r.body ? `\nHaber metni: ${r.body}` : ''}`);
  return `[CANLI WEB ARAŞTIRMASI]\n${lines.join('\n\n')}\n`;
}

