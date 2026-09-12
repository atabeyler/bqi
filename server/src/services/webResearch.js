function stripHtml(s = '') {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDuckDuckGoHtml(html) {
  const out = [];
  const blocks = [...html.matchAll(/<div class="result[\s\S]*?<\/div>\s*<\/div>/gi)];
  for (const b of blocks) {
    const chunk = b[0];
    const a = chunk.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const rawUrl = a[1];
    const title = stripHtml(a[2]);
    const sn = chunk.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)
      || chunk.match(/<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
    const snippet = sn ? stripHtml(sn[1]) : '';
    if (!title || !rawUrl) continue;
    out.push({ title, url: rawUrl, snippet });
    if (out.length >= 6) break;
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
  return parseDuckDuckGoHtml(html);
}

export function formatResearchContext(results) {
  if (!Array.isArray(results) || !results.length) return '';
  const lines = results.map((r, i) => `${i + 1}. ${r.title}\nURL: ${r.url}\nÖzet: ${r.snippet || '-'}`);
  return `[CANLI WEB ARAŞTIRMASI]\n${lines.join('\n\n')}\n`;
}

