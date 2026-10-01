import { ResearchProvider, makeEvidenceDoc } from './provider.js';

/**
 * Generic JSON-feed provider for a licensed/verified gateway.
 * Expected response: { items: [{ url, title, snippet?, publication_time? (ISO UTC), claim_key? }] }
 * SFRE does NOT scrape KAP/SPK/BIST markup: those providers stay UNAVAILABLE until an operator configures a
 * verified endpoint (env SFRE_<ID>_FEED_URL, optional SFRE_<ID>_FEED_TOKEN) that returns the schema above.
 */
export class JsonFeedProvider extends ResearchProvider {
  constructor({ id, tier, endpoint = null, token = null, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
    super({ id, tier });
    this.endpoint = endpoint; this.token = token; this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs;
  }

  isConfigured() { return !!this.endpoint; }

  async search(query, ctx) {
    const url = `${this.endpoint}${this.endpoint.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}`;
    const res = await this.fetchImpl(url, { headers: { Accept: 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) }, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`${this.id} HTTP ${res.status}`);
    const body = await res.json();
    if (!body || !Array.isArray(body.items)) throw new Error(`${this.id}: response lacks items[]`);
    const retrieval_time = ctx.now();
    return body.items.filter((i) => i && i.url).map((i) => makeEvidenceDoc({ providerId: this.id, tier: this.tier, url: i.url, title: i.title, snippet: i.snippet, publication_time: /^\d{4}-\d{2}-\d{2}T.*Z$/.test(i.publication_time || '') ? i.publication_time : null, retrieval_time, claim_key: i.claim_key ?? null }));
  }
}

/** Wraps the existing DuckDuckGo HTML research (services/webResearch.js) as ONE low-trust provider, never the sole source. */
export class DuckDuckGoProvider extends ResearchProvider {
  constructor({ researchFn = null } = {}) { super({ id: 'web:duckduckgo', tier: 'NEWS_UNVERIFIED' }); this.researchFn = researchFn; }
  isConfigured() { return true; }
  async search(query, ctx) {
    const fn = this.researchFn || (await import('../../services/webResearch.js')).researchWeb;
    const results = await fn(query);
    const retrieval_time = ctx.now();
    return results.filter((r) => r.url).map((r) => makeEvidenceDoc({ providerId: this.id, tier: this.tier, url: r.url, title: r.title, snippet: r.snippet, publication_time: null, retrieval_time }));
  }
}

const SHELLS = [
  ['official:kap', 'OFFICIAL_REGULATOR'], ['official:spk', 'OFFICIAL_REGULATOR'], ['official:borsa_istanbul', 'OFFICIAL_REGULATOR'],
  ['company:ir', 'COMPANY_IR'], ['audit:independent', 'INDEPENDENT_AUDIT'], ['data:licensed_market', 'LICENSED_MARKET_DATA'], ['news:reliable', 'NEWS_RELIABLE'],
];

/** Default shells: configured only via environment; otherwise honestly UNAVAILABLE. */
export function defaultProviders(env = process.env, fetchImpl = globalThis.fetch) {
  const list = SHELLS.map(([id, tier]) => {
    const key = id.replace(/[^a-z]+/gi, '_').toUpperCase();
    return new JsonFeedProvider({ id, tier, endpoint: env[`SFRE_${key}_FEED_URL`] || null, token: env[`SFRE_${key}_FEED_TOKEN`] || null, fetchImpl });
  });
  list.push(new DuckDuckGoProvider());
  return list;
}
