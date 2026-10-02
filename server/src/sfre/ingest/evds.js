import { mkObs, num } from './parse.js';

/**
 * TCMB EVDS (evds2.tcmb.gov.tr) client: daily macro series (FX, rates) as point-in-time observations.
 * Auth: the API key travels in the `key` header (never in the URL, so it cannot leak into logs).
 * EVDS has no per-observation publication timestamp, so every value is available from event day + lagDays (default 1) and flagged
 * ESTIMATED. Missing values (holidays) are skipped, never read as zero. Anything that is not JSON (an HTML error page for a bad key
 * or an unknown series code) is reported, not guessed.
 */
export const EVDS_BASE = 'https://evds2.tcmb.gov.tr/service/evds';
export const DEFAULT_EVDS_SERIES = Object.freeze(['TP.DK.USD.A.YTL', 'TP.DK.EUR.A.YTL']); // USD / EUR indicative buying rate (TRY)
const DAY = 86400000;
const ddmmyyyy = (iso) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

export function evdsConfig(env = process.env) {
  return {
    apiKey: env.TCMB_EVDS_KEY || null,
    baseUrl: env.SFRE_EVDS_BASE_URL || EVDS_BASE,
    series: (env.SFRE_EVDS_SERIES ? env.SFRE_EVDS_SERIES.split(',') : [...DEFAULT_EVDS_SERIES]).map((s) => s.trim()).filter(Boolean),
    start: env.SFRE_EVDS_START || '2018-01-01',
    lagDays: env.SFRE_EVDS_LAG_DAYS ? Number(env.SFRE_EVDS_LAG_DAYS) : 1,
    timeoutMs: Number(env.SFRE_EVDS_TIMEOUT_MS) || 60000,
    minIntervalMs: Number(env.SFRE_EVDS_MIN_INTERVAL_MS) || 1000,
  };
}

/** EVDS item -> observation, or null when the day has no value. `Tarih` is dd-mm-yyyy; the value key is the series code with dots as underscores. */
export function evdsItemToObservation(item, code, { lagDays = 1, ingestedMs = Date.now() } = {}) {
  const m = String(item?.Tarih ?? '').match(/^(\d{2})-(\d{2})-(\d{4})$/); if (!m) return null;
  const value = num(item[code.replace(/\./g, '_')]); if (value === null) return null;
  const eventMs = Date.UTC(+m[3], +m[2] - 1, +m[1]);
  return mkObs({ entity: `EVDS:${code}`, field: 'value', value, unit: null, eventMs, availableMs: eventMs + lagDays * DAY, source: 'tcmb:evds', ingestedMs, flags: ['ESTIMATED'] });
}

export class EvdsClient {
  constructor({ config = evdsConfig(), fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) { this.cfg = config; this.fetchImpl = fetchImpl; this.sleep = sleep; this.last = 0; }
  isConfigured() { return !!this.cfg.apiKey; }

  async fetchSeries(code, { startIso, endIso }) {
    if (!this.isConfigured()) throw Object.assign(new Error('EVDS not configured (TCMB_EVDS_KEY)'), { code: 'NOT_CONFIGURED' });
    if (!/^[A-Za-z0-9._]+$/.test(code)) throw Object.assign(new Error(`bad series code ${code}`), { code: 'BAD_CODE' });
    const wait = this.last + this.cfg.minIntervalMs - Date.now(); if (wait > 0) await this.sleep(wait);
    this.last = Date.now();
    const url = `${this.cfg.baseUrl}/series=${code}&startDate=${ddmmyyyy(startIso)}&endDate=${ddmmyyyy(endIso)}&type=json`;
    const res = await this.fetchImpl(url, { headers: { key: this.cfg.apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(this.cfg.timeoutMs) });
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`EVDS refused the key (HTTP ${res.status})`), { code: 'AUTH' });
    if (!res.ok) throw Object.assign(new Error(`EVDS HTTP ${res.status}`), { code: 'HTTP' });
    const text = await res.text(); let body;
    try { body = JSON.parse(text); } catch { throw Object.assign(new Error('EVDS returned a non-JSON page (invalid key or unknown series code)'), { code: 'SCHEMA' }); }
    if (!Array.isArray(body?.items)) throw Object.assign(new Error('EVDS response has no items array'), { code: 'SCHEMA' });
    return body.items;
  }

  /** One request per series so one bad code never hides the others. Returns {observations, perSeries}. */
  async sync({ series = this.cfg.series, startIso = this.cfg.start, endIso = new Date().toISOString().slice(0, 10), ingestedMs = Date.now() } = {}) {
    const observations = []; const perSeries = {};
    for (const code of series) {
      try {
        const items = await this.fetchSeries(code, { startIso, endIso }); let n = 0;
        for (const it of items) { const o = evdsItemToObservation(it, code, { lagDays: this.cfg.lagDays, ingestedMs }); if (o) { observations.push(o); n++; } }
        perSeries[code] = { ok: true, items: items.length, observations: n };
      } catch (e) { perSeries[code] = { ok: false, error: e.message, code: e.code ?? null }; }
    }
    return { observations, perSeries };
  }
}
