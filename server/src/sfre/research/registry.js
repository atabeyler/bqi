import { TIERS, PRIMARY_TIERS } from './provider.js';

const BLOCKED = new Set(['CONFIDENTIAL', 'RESTRICTED']);

export class ResearchRegistry {
  #providers = [];
  constructor(providers = []) { providers.forEach((p) => this.register(p)); }
  register(p) { this.#providers.push(p); this.#providers.sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier)); }
  list() { return this.#providers.map((p) => ({ id: p.id, tier: p.tier, configured: p.isConfigured() })); }

  /**
   * Queries every configured provider (highest tier first). Query text of CONFIDENTIAL/RESTRICTED requests never
   * leaves the platform (same rule as services/analysisResearch.js).
   */
  async research(query, { classification = 'PUBLIC', now = () => new Date().toISOString() } = {}) {
    const providerStatus = []; const docs = [];
    const blocked = classification && BLOCKED.has(String(classification).toUpperCase());
    for (const p of this.#providers) {
      if (blocked) { providerStatus.push({ id: p.id, tier: p.tier, status: 'BLOCKED_BY_POLICY' }); continue; }
      if (!p.isConfigured()) { providerStatus.push({ id: p.id, tier: p.tier, status: 'UNAVAILABLE' }); continue; }
      try {
        const found = await p.search(query, { now });
        docs.push(...found); providerStatus.push({ id: p.id, tier: p.tier, status: 'OK', count: found.length });
      } catch (e) { providerStatus.push({ id: p.id, tier: p.tier, status: 'ERROR', error: String(e?.message || e).slice(0, 200) }); }
    }
    const okTiers = providerStatus.filter((s) => s.status === 'OK').map((s) => s.tier);
    return {
      docs, providerStatus,
      coverage: { providersOk: providerStatus.filter((s) => s.status === 'OK').length, providersTotal: providerStatus.length, hasPrimary: okTiers.some((t) => PRIMARY_TIERS.has(t)) },
    };
  }
}

/**
 * Multi-source corroboration per claim_key: distinct independent publishers (same publisher or identical content = one).
 * CORROBORATED needs >= 2 independent publishers including >= 1 primary-tier source.
 */
export function corroborate(docs) {
  const groups = new Map();
  for (const d of docs) { if (!d.claim_key) continue; if (!groups.has(d.claim_key)) groups.set(d.claim_key, []); groups.get(d.claim_key).push(d); }
  return [...groups.entries()].map(([claim_key, list]) => {
    const seen = new Set(); const independent = [];
    for (const d of list) { const pub = d.publisher || d.id; if (!seen.has(pub) && !independent.some((x) => x.content_hash === d.content_hash)) { seen.add(pub); independent.push(d); } }
    const hasPrimary = independent.some((d) => PRIMARY_TIERS.has(d.tier));
    const level = independent.length >= 2 && hasPrimary ? 'CORROBORATED' : independent.length >= 2 ? 'MULTI_SOURCE_NO_PRIMARY' : hasPrimary ? 'SINGLE_PRIMARY_SOURCE' : 'UNVERIFIED';
    return { claim_key, independentPublishers: independent.length, hasPrimary, level, doc_ids: list.map((d) => d.id) };
  });
}
