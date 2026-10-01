import { hashOf } from '../core/canonical.js';

/** Source tiers, highest authority first. */
export const TIERS = Object.freeze(['OFFICIAL_REGULATOR', 'COMPANY_IR', 'INDEPENDENT_AUDIT', 'LICENSED_MARKET_DATA', 'NEWS_RELIABLE', 'NEWS_UNVERIFIED']);
export const PRIMARY_TIERS = new Set(['OFFICIAL_REGULATOR', 'COMPANY_IR', 'INDEPENDENT_AUDIT']);

export function publisherOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}

/** Evidence document: every important claim carries source, publication_time, retrieval_time and a content hash. */
export function makeEvidenceDoc({ providerId, tier, url, title = '', snippet = '', publication_time = null, retrieval_time, claim_key = null }) {
  if (!TIERS.includes(tier)) throw new Error(`unknown tier ${tier}`);
  if (!retrieval_time) throw new Error('retrieval_time required');
  const content = { title, snippet };
  const doc = {
    source: providerId, tier, publisher: publisherOf(url), url, title, snippet,
    publication_time, // null = UNOBSERVED (provider did not supply it; never invented)
    retrieval_time, claim_key, content_hash: hashOf(content),
  };
  doc.id = `doc_${hashOf({ ...doc, id: undefined }).slice(0, 16)}`;
  return Object.freeze(doc);
}

export class ResearchProvider {
  constructor({ id, tier, name = id }) { this.id = id; this.tier = tier; this.name = name; }
  isConfigured() { return false; }
  async search(_query, _ctx) { throw new Error('not implemented'); }
}
