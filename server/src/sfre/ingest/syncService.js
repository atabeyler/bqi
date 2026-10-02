import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { importTefas } from './tefas.js';
import { importBistEod, importFreeFloat } from './bist.js';
import { importHoldings } from './holdings.js';
import { KapClient, kapConfig } from './kap.js';
import { EvdsClient, evdsConfig } from './evds.js';

/**
 * SFRE automatic data sync: one place that knows every institution feeding the engine and how each one is reached.
 *
 *   TCMB EVDS            REST API with the key in TCMB_EVDS_KEY (FX/rate series), fetched by THIS server so any client sees the data  -> mode "api"
 *   KAP / MKK            REST API (needs MKK onboarding: SFRE_KAP_BASE_URL + SFRE_KAP_API_KEY)  -> mode "api"
 *   Borsa Istanbul, TEFAS-licensed feeds, free float, fund holdings
 *                        authorised HTTP file feed (SFRE_FEED_<KIND>_URL [+ _TOKEN])            -> mode "feed"
 *   TEFAS public site    has NO API (the platform FAQ says API sharing is not offered), so files exported from
 *                        tefas.gov.tr "Fon Verileri" are dropped in SFRE_INBOX_DIR and picked up automatically -> mode "inbox"
 *
 * Every path ends in the same validated, hash-deduplicated store.addObservations(), so re-running is always safe (idempotent).
 * Nothing is guessed: an unconfigured source reports `configured:false` and is skipped, it never fabricates data.
 */
export const FEED_KINDS = Object.freeze({
  tefas: { env: 'TEFAS', institution: 'TEFAS (Takasbank)', importer: (buf, o) => importTefas(buf, o) },
  'bist-eod': { env: 'BIST_EOD', institution: 'Borsa Istanbul', importer: (buf) => importBistEod(buf) },
  'free-float': { env: 'FREE_FLOAT', institution: 'MKK / Borsa Istanbul', importer: (buf, o) => importFreeFloat(buf, o) },
  holdings: { env: 'HOLDINGS', institution: 'KAP / fund managers', importer: (buf, o) => importHoldings(buf, o) },
});
const KINDS_BY_LENGTH = Object.keys(FEED_KINDS).sort((a, b) => b.length - a.length);
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MANIFEST = '.sfre-processed.json';
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** JSON.parse with explicit fallbacks: `empty` when the text is blank, `invalid` when it does not parse. */
function parseJson(text, empty, invalid) {
  if (!text) return empty;
  try { return JSON.parse(text); } catch { return invalid; }
}
const readManifest = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };

export function syncConfig(env = process.env) {
  const feeds = {};
  for (const [kind, d] of Object.entries(FEED_KINDS)) {
    feeds[kind] = { url: env[`SFRE_FEED_${d.env}_URL`] || null, token: env[`SFRE_FEED_${d.env}_TOKEN`] || null, header: env[`SFRE_FEED_${d.env}_AUTH_HEADER`] || 'Authorization', scheme: env[`SFRE_FEED_${d.env}_AUTH_SCHEME`] ?? 'Bearer', lagDays: env[`SFRE_FEED_${d.env}_LAG_DAYS`] ? Number(env[`SFRE_FEED_${d.env}_LAG_DAYS`]) : undefined };
  }
  const kapParams = parseJson(env.SFRE_KAP_SYNC_PARAMS, {}, null);
  return {
    enabled: env.SFRE_SYNC_ENABLED === 'true', intervalMs: Math.max(1, Number(env.SFRE_SYNC_INTERVAL_MIN) || 60) * 60000,
    inboxDir: env.SFRE_INBOX_DIR || null, feeds, kapParams, timeoutMs: Number(env.SFRE_FEED_TIMEOUT_MS) || 120000,
  };
}

/** `tefas_2026-09.xlsx`, `bist-eod-20260930.csv`, `holdings_x.xlsx` -> kind (longest prefix wins); null = not recognised. */
export function kindFromFilename(name) {
  const n = name.toLowerCase();
  return KINDS_BY_LENGTH.find((k) => n.startsWith(`${k}_`) || n.startsWith(`${k}-`) || n.startsWith(`${k}.`)) ?? null;
}

export class SfreSyncService {
  constructor({ store, env = process.env, kapClient = null, evdsClient = null, fetchImpl = globalThis.fetch, log = { info() {}, warn() {} } } = {}) {
    if (!store?.addObservations) throw new Error('SfreSyncService needs a store with addObservations()');
    this.store = store; this.cfg = syncConfig(env); this.fetchImpl = fetchImpl; this.log = log;
    this.kap = kapClient || new KapClient({ config: kapConfig(env) });
    this.evds = evdsClient || new EvdsClient({ config: evdsConfig(env), fetchImpl });
    this.last = {}; this.running = null; this.timer = null;
  }

  sources() {
    const c = this.cfg;
    return [
      { id: 'evds', institution: 'TCMB EVDS', mode: 'api', configured: this.evds.isConfigured(), series: this.evds.cfg.series },
      { id: 'kap', institution: 'KAP / MKK', mode: 'api', configured: this.kap.isConfigured() && c.kapParams !== null, note: c.kapParams === null ? 'SFRE_KAP_SYNC_PARAMS is not valid JSON' : undefined },
      ...Object.entries(FEED_KINDS).map(([kind, d]) => ({ id: `feed:${kind}`, institution: d.institution, mode: 'feed', configured: !!c.feeds[kind].url })),
      { id: 'inbox', institution: 'TEFAS public export / manual drops', mode: 'inbox', configured: !!c.inboxDir, dir: c.inboxDir },
    ];
  }

  status() { return { enabled: this.cfg.enabled, intervalMinutes: this.cfg.intervalMs / 60000, running: !!this.running, sources: this.sources().map((s) => ({ ...s, last: this.last[s.id] ?? null })) }; }

  async #save(result) {
    const r = await this.store.addObservations(result.observations);
    return { rows: result.report?.rows ?? result.report?.accepted ?? null, skipped: result.skipped?.length ?? 0, inserted: r.inserted, duplicates: r.duplicates, rejected: r.rejected.length };
  }

  async #guard(id, fn) {
    const at = new Date().toISOString();
    try { this.last[id] = { at, ok: true, ...(await fn()) }; } catch (e) { this.last[id] = { at, ok: false, error: e.message, code: e.code ?? null }; this.log.warn({ err: e, source: id }, '[SFRE sync] source failed'); }
    return this.last[id];
  }

  async syncKap() {
    return this.#guard('kap', async () => {
      if (!this.kap.isConfigured() || this.cfg.kapParams === null) return { skipped: 'not configured' };
      const r = await this.kap.syncDisclosures(this.cfg.kapParams);
      return { total: r.total, accepted: r.disclosures.length, rejectedByReason: r.rejected, ...(await this.#save({ observations: r.observations, skipped: [], report: { accepted: r.disclosures.length } })) };
    });
  }

  /** Pulls the configured EVDS series (default: USD/EUR vs TRY since 2018). Per-series outcome is reported; one bad code does not hide the others. */
  async syncEvds() {
    return this.#guard('evds', async () => {
      if (!this.evds.isConfigured()) return { skipped: 'not configured' };
      const { observations, perSeries } = await this.evds.sync();
      const saved = await this.#save({ observations, skipped: [], report: { rows: observations.length } });
      const failed = Object.entries(perSeries).filter(([, v]) => !v.ok);
      return { series: perSeries, ...saved, ...(failed.length ? { partial: true } : {}) };
    });
  }

  async syncFeed(kind) {
    const f = this.cfg.feeds[kind];
    return this.#guard(`feed:${kind}`, async () => {
      if (!f.url) return { skipped: 'not configured' };
      const headers = f.token ? { [f.header]: f.scheme ? `${f.scheme} ${f.token}` : f.token } : {};
      const res = await this.fetchImpl(f.url, { headers, signal: AbortSignal.timeout(this.cfg.timeoutMs) });
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`feed refused the credentials (HTTP ${res.status})`), { code: 'AUTH' });
      if (!res.ok) throw Object.assign(new Error(`feed HTTP ${res.status}`), { code: 'HTTP' });
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_FILE_BYTES) throw Object.assign(new Error('feed larger than 50 MB'), { code: 'TOO_LARGE' });
      return { bytes: buf.length, ...(await this.#save(FEED_KINDS[kind].importer(buf, { lagDays: f.lagDays }))) };
    });
  }

  /** Imports every not-yet-seen file in the inbox. A file is identified by content hash, so renames/re-drops never double count. */
  async syncInbox() {
    return this.#guard('inbox', async () => {
      const dir = this.cfg.inboxDir;
      if (!dir) return { skipped: 'not configured' };
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const mf = path.join(dir, MANIFEST);
      const seen = readManifest(mf);
      const out = { files: 0, imported: 0, alreadySeen: 0, unrecognised: [], failed: [], inserted: 0, duplicates: 0 };
      for (const name of readdirSync(dir).sort()) {
        const full = path.join(dir, name);
        if (name.startsWith('.') || !statSync(full).isFile() || !/\.(xlsx|xls|csv)$/i.test(name)) continue;
        out.files++;
        const kind = kindFromFilename(name);
        if (!kind) { out.unrecognised.push(name); continue; }
        const buf = readFileSync(full);
        if (buf.length > MAX_FILE_BYTES) { out.failed.push({ file: name, error: 'larger than 50 MB' }); continue; }
        const h = sha256(buf);
        if (seen[h]) { out.alreadySeen++; continue; }
        try {
          const r = await this.#save(FEED_KINDS[kind].importer(buf, { lagDays: this.cfg.feeds[kind].lagDays }));
          seen[h] = { file: name, kind, at: new Date().toISOString(), inserted: r.inserted };
          out.imported++; out.inserted += r.inserted; out.duplicates += r.duplicates;
        } catch (e) { out.failed.push({ file: name, error: e.message }); }
      }
      writeFileSync(mf, JSON.stringify(seen, null, 2));
      return out;
    });
  }

  /** Runs every configured source once. Single-flight: a second call while one is running returns the running one. */
  runAll() {
    this.running ||= (async () => {
      const results = {};
      results.evds = await this.syncEvds();
      results.kap = await this.syncKap();
      for (const kind of Object.keys(FEED_KINDS)) results[`feed:${kind}`] = await this.syncFeed(kind);
      results.inbox = await this.syncInbox();
      return results;
    })().finally(() => { this.running = null; });
    return this.running;
  }

  start() {
    if (this.timer || !this.cfg.enabled) return false;
    this.runAll().catch((e) => this.log.warn({ err: e }, '[SFRE sync] initial run failed'));
    this.timer = setInterval(() => this.runAll().catch((e) => this.log.warn({ err: e }, '[SFRE sync] run failed')), this.cfg.intervalMs);
    this.timer.unref?.();
    return true;
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

/** Process-wide instance shared by the boot-time scheduler and the /api/sfre/sync routes (PostgreSQL only; null without it). */
let shared = null;
export async function getSharedSync(query, log) {
  if (shared) return shared;
  const { PgStore } = await import('../storage/pgStore.js');
  const store = new PgStore(query); await store.ensureSchema();
  shared = new SfreSyncService({ store, log });
  return shared;
}
