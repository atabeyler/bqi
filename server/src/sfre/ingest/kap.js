import { mkObs } from './parse.js';
import { hashOf } from '../core/canonical.js';

/**
 * MKK "KAP Veri Yayın Servisi" (REST) client.
 * Service names (disclosures, disclosureDetail, downloadAttachment, lastDisclosureIndex, members, memberDetail, funds, fundDetail,
 * memberSecurities, blockedDisclosures, caEventStatus) come from MKK's official PDF; the PDF does NOT document request parameters,
 * response schemas, base URL or the auth header. Therefore EVERYTHING below is configuration, and the response normalizer is tolerant
 * but strict about the two things the PIT contract needs (a disclosure id and a parseable publication time): records lacking either are
 * REJECTED and counted, never guessed. The first live call must be inspected (`sfre-ingest.js kap-probe`) and the field aliases adjusted.
 */
export const KAP_SERVICES = Object.freeze(['disclosures', 'disclosureDetail', 'downloadAttachment', 'lastDisclosureIndex', 'members', 'memberDetail', 'funds', 'fundDetail', 'memberSecurities', 'blockedDisclosures', 'caEventStatus']);

export function kapConfig(env = process.env) {
  return {
    baseUrl: env.SFRE_KAP_BASE_URL || null, apiKey: env.SFRE_KAP_API_KEY || null,
    authHeader: env.SFRE_KAP_AUTH_HEADER || 'Authorization', authScheme: env.SFRE_KAP_AUTH_SCHEME ?? 'Bearer',
    timeoutMs: Number(env.SFRE_KAP_TIMEOUT_MS) || 20000, minIntervalMs: Number(env.SFRE_KAP_MIN_INTERVAL_MS) || 1000,
  };
}

const pick = (o, names) => { for (const n of names) if (o && o[n] !== undefined && o[n] !== null && o[n] !== '') return o[n]; return null; };

export function parsePublishTime(v) {
  if (v === null) return null;
  if (typeof v === 'number') return v > 1e11 ? v : v * 1000; // epoch ms or s
  const s = String(v).trim();
  let m = s.match(/^(\d{2})[./](\d{2})[./](\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/); // dd.mm.yyyy HH:mm[:ss], Europe/Istanbul (UTC+3, no DST since 2016)
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4] - 3, +m[5], +(m[6] || 0));
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) { const t = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}+03:00`); return Number.isNaN(t) ? null : t; } // zone-less ISO is assumed Istanbul local time
  return null;
}

/** One raw disclosure -> {disclosure, observation} or {rejected: reason}. */
export function normalizeDisclosure(raw, { retrievedMs = Date.now(), source = 'official:kap' } = {}) {
  const id = pick(raw, ['disclosureIndex', 'disclosureId', 'index', 'id', 'bildirimNo']);
  const publishedMs = parsePublishTime(pick(raw, ['publishDate', 'publishTime', 'disclosureDate', 'time', 'yayinTarihi']));
  if (id === null) return { rejected: 'NO_ID' };
  if (publishedMs === null) return { rejected: 'NO_PUBLICATION_TIME' };
  const company = pick(raw, ['stockCode', 'stockCodes', 'ticker', 'companyCode', 'memberCode', 'fundCode', 'companyTitle', 'memberTitle', 'title2']) ;
  const title = String(pick(raw, ['title', 'subject', 'summary', 'disclosureTitle', 'konu']) ?? '');
  const category = pick(raw, ['disclosureType', 'disclosureClass', 'category', 'subject']);
  const entityKey = String(company ?? 'UNKNOWN').split(',')[0].trim().toUpperCase();
  const disclosure = { id: String(id), company: entityKey, published_time: new Date(publishedMs).toISOString().replace(/\.\d{3}Z$/, 'Z'), retrieved_time: new Date(retrievedMs).toISOString().replace(/\.\d{3}Z$/, 'Z'), title, category: category === null ? null : String(category), source };
  const observation = mkObs({ entity: `KAP:${entityKey}`, field: 'disclosure', value: JSON.stringify({ id: disclosure.id, title, category: disclosure.category, content_hash: hashOf({ title, category: disclosure.category }) }), unit: null, eventMs: publishedMs, publishedMs, availableMs: publishedMs, ingestedMs: retrievedMs, source });
  return { disclosure, observation };
}

export class KapClient {
  constructor({ config = kapConfig(), fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.cfg = config; this.fetchImpl = fetchImpl; this.sleep = sleep; this.last = 0;
  }
  isConfigured() { return !!(this.cfg.baseUrl && this.cfg.apiKey); }

  async call(service, params = {}) {
    if (!KAP_SERVICES.includes(service)) throw new Error(`unknown KAP service ${service}`);
    if (!this.isConfigured()) throw Object.assign(new Error('KAP API not configured (SFRE_KAP_BASE_URL / SFRE_KAP_API_KEY)'), { code: 'NOT_CONFIGURED' });
    const wait = this.last + this.cfg.minIntervalMs - Date.now(); if (wait > 0) await this.sleep(wait); // polite rate limit
    this.last = Date.now();
    const url = new URL(`${this.cfg.baseUrl.replace(/\/$/, '')}/${service}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const headers = { Accept: 'application/json', [this.cfg.authHeader]: this.cfg.authScheme ? `${this.cfg.authScheme} ${this.cfg.apiKey}` : this.cfg.apiKey };
    const res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(this.cfg.timeoutMs) });
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`KAP API refused the credentials (HTTP ${res.status})`), { code: 'AUTH' });
    if (!res.ok) throw Object.assign(new Error(`KAP API HTTP ${res.status}`), { code: 'HTTP' });
    return res.json();
  }

  /** Pulls a disclosure list and normalizes it. `listPath` lets operators point at the array inside the response (default: array itself or .data/.items/.disclosures). */
  async syncDisclosures(params = {}, { retrievedMs = Date.now() } = {}) {
    const body = await this.call('disclosures', params);
    const list = Array.isArray(body) ? body : (body?.data ?? body?.items ?? body?.disclosures ?? null);
    if (!Array.isArray(list)) throw Object.assign(new Error('unrecognised KAP response shape: no array found (inspect with kap-probe)'), { code: 'SCHEMA' });
    const out = { disclosures: [], observations: [], rejected: {} };
    for (const raw of list) {
      const r = normalizeDisclosure(raw, { retrievedMs });
      if (r.rejected) out.rejected[r.rejected] = (out.rejected[r.rejected] || 0) + 1; else { out.disclosures.push(r.disclosure); out.observations.push(r.observation); }
    }
    return { ...out, total: list.length };
  }
}
