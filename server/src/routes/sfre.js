import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole, ROLES, resolveRole } from '../lib/rbac.js';
import { logger } from '../lib/logger.js';
import { runInWorker } from '../sfre/jobs/runner.js';
import { recordRun, validateRequest } from '../sfre/pipeline.js';
import { EvidenceLedger } from '../sfre/evidence/ledger.js';
import { ModelRegistry, createDefaultRegistry, registerMissingDefaults, GovernanceError } from '../sfre/governance/modelRegistry.js';
import { explainResults } from '../sfre/ai/firewall.js';
import { buildRetailRiskTable } from '../sfre/alerts/retailRiskTable.js';
import { MemoryStore } from '../sfre/storage/store.js';
import { PgStore } from '../sfre/storage/pgStore.js';
import { defaultProviders } from '../sfre/research/providers.js';
import { ResearchRegistry } from '../sfre/research/registry.js';
import { analysisLimiter, uploadLimiter } from '../middleware/rateLimit.js';
import multer from 'multer';
import { createHash } from 'node:crypto';
import { matchesDeclaredFileType } from '../lib/fileSignature.js';
import { detectFxShocks, scoreEvents } from '../sfre/engines/fxShock.js';
import { gatherReportInputs, buildReport, notifyIfChanged } from '../sfre/report/service.js';
import { normLang } from '../sfre/report/i18n.js';
import { renderReportHtml } from '../sfre/report/situationReport.js';
import { archiveReport, listReports, getReport, deleteReport } from '../sfre/report/archive.js';
import { buildDocModel } from '../sfre/report/docModel.js';
import { renderReportPdf, renderReportDocx } from '../sfre/report/exportFiles.js';
import { sendSfreReportEmail } from '../services/email.js';
import { importTefas } from '../sfre/ingest/tefas.js';
import { importBistEod, importFreeFloat } from '../sfre/ingest/bist.js';
import { importHoldings } from '../sfre/ingest/holdings.js';
import { getSharedSync } from '../sfre/ingest/syncService.js';
import { systemFromView } from '../sfre/validation/fragilityAlarm.js';
import { describeCapabilities } from '../sfre/capabilities.js';

export const INGEST_KINDS = Object.freeze({
  tefas: (buf, o) => importTefas(buf, o), 'bist-eod': (buf) => importBistEod(buf), 'free-float': (buf, o) => importFreeFloat(buf, o), holdings: (buf, o) => importHoldings(buf, o),
});
export const PURGE_CONFIRM = 'DELETE-BFI-OBSERVATIONS';
const FROM_DATA_ENGINES = ['cascade', 'concentration', 'overlap', 'counterfactual'];
const DAY_MS = 86400000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

/**
 * /api/sfre -- Systemic Financial Risk & Market Integrity Engine.
 * Analytical measurement under stated uncertainty: never investment advice, never an allegation.
 * Persistence: PostgreSQL when `pg` is supplied (production: DATABASE_URL), otherwise process memory (dev/tests).
 * Heavy computation runs in a worker thread with timeout + concurrency cap.
 */
function parseAsOf(v) {
  if (typeof v !== 'string') return null;
  const s = /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T23:59:59Z` : v; // a bare date means "end of that UTC day"
  const t = Date.parse(s); return Number.isNaN(t) || !/Z$/.test(s) ? null : new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function createSfreRouter({ store = null, pg = null, ledger = null, registry = null, explainLlm = null, research = null, runner = runInWorker, sync = null } = {}) {
  const router = express.Router();
  const mem = store || new MemoryStore();
  const db = pg ? new PgStore(pg) : null;
  let state = null; // {ledger, registry}
  let initializing = null;
  const ready = () => {
    if (state) return Promise.resolve(state);
    // single-flight: concurrent first requests share one initialisation; a failure is not cached (next request retries)
    initializing ||= init().finally(() => { initializing = null; });
    return initializing;
  };
  const init = async () => {
    let l = ledger; let r = registry;
    if (db) {
      await db.ensureSchema();
      l = l || await db.loadLedger();
      r = r || new ModelRegistry().loadState(await db.loadModels());
      if (!r.list().length) { r = createDefaultRegistry(); await db.saveModels(r); } else if (!registry && registerMissingDefaults(r).length) await db.saveModels(r);
    }
    state = { ledger: l || new EvidenceLedger(), registry: r || createDefaultRegistry() };
    return state;
  };
  const S = db || mem; // run/result/claim-owner store
  const canRead = (req, owner) => resolveRole(req.user) === ROLES.ADMIN || owner === req.user.userCode;
  const providers = research || new ResearchRegistry(defaultProviders());

  router.use(authMiddleware);
  router.use(async (_req, res, next) => { try { await ready(); next(); } catch (e) { logger.error({ err: e }, '[SFRE] init failed'); res.status(503).json({ error: 'SFRE storage unavailable' }); } });

  router.get('/health', async (_req, res) => {
    const { ledger: l, registry: r } = state;
    res.json({ ok: true, engine: 'SFRE', version: '1.0.0', storage: db ? 'postgres' : 'memory', models: r.list().length, ledger: l.verify(), providers: providers.list() });
  });

  router.get('/data/status', requireRole(ROLES.ADMIN, ROLES.ANALYST), async (_req, res) => {
    if (!db) return res.json({ storage: 'memory', observations: null, note: 'no database configured: no persisted observations' });
    const r = await pg('SELECT source, field, count(*)::int AS n, min(available_time) AS first_available, max(available_time) AS last_available FROM sfre_observations GROUP BY source, field ORDER BY source, field');
    // table/database size in bytes; best effort, some managed databases restrict pg_database_size
    const size = await pg("SELECT pg_total_relation_size('sfre_observations')::float8 AS obs, pg_database_size(current_database())::float8 AS db").then((z) => ({ observationsBytes: z.rows[0].obs, databaseBytes: z.rows[0].db })).catch(() => null);
    res.json({ storage: 'postgres', datasets: r.rows, size });
  });

  // Automatic data sync (KAP/MKK API, authorised institution feeds, TEFAS file inbox). Admin only; see docs/sfre/OPERATIONS.md.
  const syncService = async () => sync || (pg ? getSharedSync(pg, logger) : null);
  router.get('/sync/status', requireRole(ROLES.ADMIN), async (_req, res) => {
    const svc = await syncService();
    if (!svc) return res.json({ available: false, note: 'automatic sync needs DATABASE_URL (observations are persisted)' });
    res.json({ available: true, ...svc.status() });
  });
  router.post('/sync/run', requireRole(ROLES.ADMIN), async (_req, res) => {
    const svc = await syncService();
    if (!svc) return res.status(409).json({ error: 'automatic sync needs DATABASE_URL' });
    res.json({ results: await svc.runAll(), status: svc.status() });
  });

  // vNext: what each systemic/surveillance engine needs, assumes and cannot claim, with live governance state per model
  router.get('/capabilities', (_req, res) => {
    const states = Object.fromEntries(state.registry.list().map((m) => [`${m.model_id}@${m.version}`, m.state]));
    res.json({ capabilities: describeCapabilities(states), note: 'All vNext models are UNCALIBRATED scenario/pattern models until promoted through governance with real-data validation evidence.' });
  });

  router.get('/models', (_req, res) => res.json({ models: state.registry.list().map((m) => ({ model_id: m.model_id, version: m.version, state: m.state, calibration: m.calibration, approved_use: m.approved_use })) }));

  router.post('/models/:id/transition', requireRole(ROLES.ADMIN), async (req, res) => {
    const { version = '1.0.0', to, evidence } = req.body || {};
    try {
      // the acting identity is the authenticated user, never the request body; API callers are 'human'
      const rec = state.registry.transition(req.params.id, version, to, { actor: { id: req.user.userCode, kind: 'human' }, evidence });
      if (db) await db.saveModels(state.registry);
      res.json({ model: { model_id: rec.model_id, version: rec.version, state: rec.state, calibration: rec.calibration, approved_use: rec.approved_use } });
    } catch (e) {
      if (e instanceof GovernanceError) return res.status(409).json({ error: e.message });
      logger.error({ err: e }, '[SFRE] transition failed');
      res.status(500).json({ error: 'internal error' });
    }
  });

  router.post('/runs', analysisLimiter, requireRole(ROLES.ADMIN, ROLES.ANALYST), async (req, res) => {
    try {
      const bad = validateRequest(req.body); if (bad) return res.status(400).json({ error: bad });
      const states = Object.fromEntries(state.registry.list().map((m) => [`${m.model_id}@${m.version}`, m.state]));
      const out = recordRun(await runner(req.body, states), state.ledger);
      await S.append('runs', { ...out.run, id: out.run.run_id, created_by: req.user.userCode });
      await S.append('results', { id: out.run.run_id, results: out.results, claims: out.claims, created_by: req.user.userCode });
      for (const claimId of Object.values(out.claims)) await S.append('claim_owners', { id: claimId, created_by: req.user.userCode });
      if (db) await db.saveLedger(state.ledger);
      const byKey = {}; for (const r of out.results) byKey[r.engine] ||= r;
      res.status(201).json({ run: out.run, production_status: out.production_status, non_production_models: out.non_production_models, snapshot: out.snapshot, results: out.results, claims: out.claims, retail_table: buildRetailRiskTable({ contagion: byKey.cascade, price_anomaly: byKey.anomaly, concentration: byKey.concentration, liquidity: byKey.liquidity, fundamental_divergence: byKey.divergence, valuation_divergence: byKey.valuation, attention_promotion: byKey.attention }) });
    } catch (e) {
      if (e.code === 'INVALID_REQUEST') return res.status(400).json({ error: e.message });
      if (e.code === 'BUSY') return res.status(429).json({ error: 'SFRE is busy, retry shortly' });
      if (e.code === 'TIMEOUT') return res.status(504).json({ error: 'run exceeded the time limit; reduce the request size' });
      logger.error({ err: e }, '[SFRE] run failed');
      res.status(500).json({ error: 'internal error' });
    }
  });

  router.get('/runs/:id', requireRole(ROLES.ADMIN, ROLES.ANALYST, ROLES.VIEWER), async (req, res) => {
    const run = await S.get('runs', req.params.id); if (!run || !canRead(req, run.created_by)) return res.status(404).json({ error: 'not found' });
    res.json({ run, results: await S.get('results', req.params.id) });
  });

  router.get('/claims/:claimId/explain', requireRole(ROLES.ADMIN, ROLES.ANALYST, ROLES.VIEWER), async (req, res) => {
    const owner = await S.get('claim_owners', req.params.claimId);
    const ex = owner && canRead(req, owner.created_by) ? state.ledger.explain(req.params.claimId) : null;
    if (!ex) return res.status(404).json({ error: 'claim not found' });
    res.json(ex); // evidence graph, not LLM text
  });

  // ---- data: universe, ingestion, runs on ingested data -------------------------------------------------
  router.get('/data/universe', requireRole(ROLES.ADMIN, ROLES.ANALYST), async (req, res) => {
    if (!db) return res.json({ storage: 'memory', funds: [], assets: [] });
    const asOf = parseAsOf(req.query.asOf); if (!asOf) return res.status(400).json({ error: 'asOf must be an ISO-8601 UTC time or date' });
    const f = await pg("SELECT DISTINCT entity FROM sfre_observations WHERE field='holdings' AND available_time <= $1 ORDER BY entity LIMIT 2000", [asOf]);
    const a = await pg("SELECT DISTINCT entity FROM sfre_observations WHERE field='close' AND available_time <= $1 ORDER BY entity LIMIT 5000", [asOf]);
    res.json({ storage: 'postgres', asOf, funds: f.rows.map((r) => r.entity), assets: a.rows.map((r) => r.entity) });
  });

  router.post('/ingest/:kind', uploadLimiter, requireRole(ROLES.ADMIN), (req, res, next) => upload.single('file')(req, res, (e) => (e ? res.status(400).json({ error: e.code === 'LIMIT_FILE_SIZE' ? 'file too large (25 MB max)' : 'upload failed' }) : next())), async (req, res) => {
    const importer = INGEST_KINDS[req.params.kind];
    if (!importer) return res.status(404).json({ error: `unknown kind; use ${Object.keys(INGEST_KINDS).join(', ')}` });
    if (!db) return res.status(409).json({ error: 'a database (DATABASE_URL) is required to store ingested data' });
    const f = req.file; if (!f) return res.status(400).json({ error: 'file required' });
    const name = String(f.originalname || '').toLowerCase();
    const ok = /\.xlsx$/.test(name) ? matchesDeclaredFileType(f.buffer, 'office') : /\.xls$/.test(name) ? matchesDeclaredFileType(f.buffer, 'legacyOffice') : /\.csv$/.test(name) ? matchesDeclaredFileType(f.buffer, 'text') : false;
    if (!ok) return res.status(400).json({ error: 'only .xlsx, .xls or .csv files whose content matches the extension are accepted' });
    const lag = req.body?.lagDays !== undefined && req.body.lagDays !== '' ? Number(req.body.lagDays) : undefined;
    if (lag !== undefined && !(Number.isFinite(lag) && lag >= 0 && lag <= 90)) return res.status(400).json({ error: 'lagDays must be between 0 and 90' });
    let out;
    try { out = importer(f.buffer, { lagDays: lag }); } catch (e) {
      logger.error({ err: e }, '[SFRE] ingest parse failed');
      return res.status(422).json({ error: 'file could not be parsed' }); // no parser internals leaked
    }
    try {
      const saved = await db.addObservations(out.observations);
      const record = { id: `ingest_${createHash('sha256').update(f.buffer).digest('hex').slice(0, 20)}_${Date.now()}`, kind: req.params.kind, filename: String(f.originalname).slice(0, 200), bytes: f.size, lagDays: lag ?? null, report: out.report, skipped: out.skipped, inserted: saved.inserted, duplicates: saved.duplicates, rejected: saved.rejected.length, created_by: req.user.userCode };
      await db.append('ingests', record);
      res.status(201).json(record);
    } catch (e) {
      // the file parsed fine: this is a storage failure (disk/quota/connection), which must not be reported as a bad file
      logger.error({ err: e }, '[SFRE] ingest storage write failed');
      res.status(503).json({ error: 'storage write failed: the file was read but could not be saved (database full, quota or connection problem); part of it may already be stored, re-uploading is safe (duplicates are ignored)' });
    }
  });

  const idStamp = (id) => Number(String(id).split('_').pop()) || 0; // ingest ids end with the epoch ms of the upload
  router.get('/data/fx-shocks', requireRole(ROLES.ADMIN, ROLES.ANALYST), async (req, res) => {
    if (!db) return res.json({ storage: 'memory', series: null });
    const code = String(req.query.series || 'TP.DK.USD.A.YTL'); if (!/^[A-Za-z0-9._]+$/.test(code)) return res.status(400).json({ error: 'bad series code' });
    const r = await pg("SELECT to_char(event_time AT TIME ZONE 'UTC','YYYY-MM-DD') AS d, value FROM sfre_observations WHERE entity=$1 AND field='value' ORDER BY event_time", [`EVDS:${code}`]);
    const seen = new Map(); for (const x of r.rows) seen.set(x.d, Number(x.value));
    const det = detectFxShocks([...seen].map(([date, value]) => ({ date, value })));
    res.json({ series: code, ...det, ...scoreEvents(det.flags) });
  });
  // Situation report: one level + reasons + printable HTML (open in a browser and print to PDF). ?format=json returns the assessment only.
  router.get('/report', requireRole(ROLES.ADMIN, ROLES.ANALYST), async (req, res) => {
    try {
      const lang = normLang(req.query.lang);
      const report = buildReport(await gatherReportInputs({ db, pg, registry: state.registry }), { version: process.env.npm_package_version || null, lang });
      if (req.query.format === 'json') return res.json({ assessment: report.assessment });
      await sendReport(res, { html: report.html, model: report.model }, req.query.format);
    } catch (e) { logger.error({ err: e }, '[SFRE] report failed'); res.status(503).json({ error: 'report could not be built' }); }
  });
  const FORMATS = { pdf: ['application/pdf', 'pdf'], docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'] };
  async function sendReport(res, { html, model }, format) {
    if (!format || format === 'html') return res.set(HTML_HEADERS).send(html);
    const f = FORMATS[format]; if (!f) return res.status(400).json({ error: 'format must be html, pdf or docx' });
    if (!model) return res.status(404).json({ error: 'this format is not available for an older archived report' });
    const buf = format === 'pdf' ? await renderReportPdf(model) : await renderReportDocx(model);
    res.set({ 'Content-Type': f[0], 'Content-Disposition': `attachment; filename="BFI-Report-${model.id}-${model.lang}.${f[1]}"`, 'Cache-Control': 'no-store' }).send(buf);
  }
  // Archive: a manual "archive now" snapshot, the list (no bodies), one stored report, and a soft delete (records are append-only: a tombstone hides it).
  const HTML_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" };
  router.post('/reports', analysisLimiter, requireRole(ROLES.ADMIN, ROLES.ANALYST), async (req, res) => {
    if (!db) return res.status(409).json({ error: 'the archive needs a database' });
    try {
      const report = buildReport(await gatherReportInputs({ db, pg, registry: state.registry }), { version: process.env.npm_package_version || null });
      res.status(201).json({ report: await archiveReport(db, { report, trigger: 'manual', by: req.user.userCode }) });
    } catch (e) { logger.error({ err: e }, '[SFRE] report archive failed'); res.status(503).json({ error: 'report could not be archived' }); }
  });
  router.get('/reports', requireRole(ROLES.ADMIN, ROLES.ANALYST), async (_req, res) => {
    if (!db) return res.json({ reports: [] });
    try { res.json({ reports: await listReports(db) }); } catch (e) { logger.error({ err: e }, '[SFRE] report list failed'); res.status(503).json({ error: 'archive unavailable' }); }
  });
  router.get('/reports/:id', requireRole(ROLES.ADMIN, ROLES.ANALYST), async (req, res) => {
    if (!db) return res.status(404).json({ error: 'not found' });
    try { const r = await getReport(db, req.params.id); if (!r) return res.status(404).json({ error: 'not found' }); const lang = normLang(req.query.lang); const parts = r.data ? { assessment: r.data.assessment, breadth: r.data.breadth, fx: r.data.fx, meta: r.data.meta } : null; await sendReport(res, { html: parts ? renderReportHtml(parts, lang) : r.html, model: parts ? buildDocModel(parts, lang) : null }, req.query.format); }
    catch (e) { logger.error({ err: e }, '[SFRE] report open failed'); res.status(503).json({ error: 'archive unavailable' }); }
  });
  router.delete('/reports/:id', requireRole(ROLES.ADMIN), async (req, res) => {
    if (!db) return res.status(404).json({ error: 'not found' });
    try {
      if (!(await deleteReport(db, { id: req.params.id, by: req.user.userCode }))) return res.status(404).json({ error: 'not found' });
      logger.warn({ report: req.params.id, by: req.user.userCode }, '[SFRE] archived report deleted'); res.json({ ok: true });
    } catch (e) { logger.error({ err: e }, '[SFRE] report delete failed'); res.status(503).json({ error: 'delete failed; nothing was removed' }); }
  });
  router.post('/report/notify', requireRole(ROLES.ADMIN), async (req, res) => {
    try { res.json(await notifyIfChanged({ db, pg, registry: state.registry, send: sendSfreReportEmail, force: req.body?.force === true, version: process.env.npm_package_version || null, lang: process.env.SFRE_REPORT_LANG || 'tr' })); }
    catch (e) { logger.error({ err: e }, '[SFRE] report notify failed'); res.status(503).json({ error: 'notification failed' }); }
  });
  router.get('/data/ingests', requireRole(ROLES.ADMIN, ROLES.ANALYST), async (_req, res) => {
    if (!db) return res.json({ ingests: [] });
    const lastPurgeMs = Math.max(0, ...(await db.list('purges', 50)).map((x) => Date.parse(x.at) || 0));
    res.json({ ingests: (await db.list('ingests', 50)).map((i) => ({ ...i, purged: idStamp(i.id) <= lastPurgeMs })) });
  });

  // Results pushed by local BFI nodes (see routes/sfreFederation.js): list without payloads, then one payload on demand.
  router.get('/federation', requireRole(ROLES.ADMIN, ROLES.ANALYST), async (_req, res) => {
    if (!db) return res.json({ items: [] });
    res.json({ items: (await db.list('federated', 50)).map(({ payload, ...rest }) => { void payload; return rest; }) });
  });
  router.get('/federation/:id', requireRole(ROLES.ADMIN, ROLES.ANALYST), async (req, res) => {
    if (!db || !/^fed_[a-f0-9]{32}$/.test(req.params.id)) return res.status(404).json({ error: 'not found' });
    const item = await db.get('federated', req.params.id);
    return item ? res.json(item) : res.status(404).json({ error: 'not found' });
  });

  // Admin-only purge of ALL ingested market/fund observations (the append-only table is dropped and recreated empty).
  // Runs, evidence ledger and model governance are untouched. The action itself is recorded (who, when, how many rows).
  router.post('/data/purge', requireRole(ROLES.ADMIN), async (req, res) => {
    if (!db) return res.status(409).json({ error: 'a database (DATABASE_URL) is required' });
    if (req.body?.confirm !== PURGE_CONFIRM) return res.status(400).json({ error: 'confirmation token missing or wrong' });
    try {
      const before = (await pg("SELECT count(*)::int AS n, pg_total_relation_size('sfre_observations')::float8 AS bytes FROM sfre_observations")).rows[0];
      await pg('DROP TABLE IF EXISTS sfre_observations CASCADE');
      await db.ensureSchema(); // recreates the empty table, indexes and append-only trigger
      const record = { id: `purge_${Date.now()}`, kind: 'observations', by: req.user.userCode, at: new Date().toISOString(), rows: before.n, bytes: before.bytes };
      await db.append('purges', record);
      logger.warn({ purge: record }, '[SFRE] observations purged by admin');
      res.json({ ok: true, removedRows: before.n, freedBytes: before.bytes, at: record.at });
    } catch (e) {
      logger.error({ err: e }, '[SFRE] purge failed');
      res.status(503).json({ error: 'purge failed; nothing was recorded as deleted' });
    }
  });

  router.post('/runs/from-data', analysisLimiter, requireRole(ROLES.ADMIN, ROLES.ANALYST), async (req, res) => {
    if (!db) return res.status(409).json({ error: 'a database with ingested data is required' });
    try {
      const b = req.body || {}; const asOf = parseAsOf(b.asOf); if (!asOf) return res.status(400).json({ error: 'asOf must be an ISO-8601 UTC time or date' });
      const engines = Array.isArray(b.engines) && b.engines.length ? b.engines : ['cascade', 'concentration'];
      if (engines.some((e) => !FROM_DATA_ENGINES.includes(e))) return res.status(400).json({ error: `engines must be a subset of ${FROM_DATA_ENGINES.join(', ')}` });
      if (!Number.isInteger(b.seed)) return res.status(400).json({ error: 'integer seed required' });
      const since = new Date(Date.parse(asOf) - 400 * DAY_MS).toISOString();
      const pit = await db.loadPitStore({ asOfMax: asOf, sinceEventTime: since });
      const view = pit.asOf(asOf);
      const assetIds = view.entities('BIST:').filter((e) => view.latest(e, 'close')); const fundIds = view.entities('FUND:').filter((e) => view.latest(e, 'holdings'));
      const { skipped, ...system } = systemFromView(view, assetIds, fundIds);
      if (!system.funds.length) return res.status(422).json({ error: 'no fund has holdings, AUM and cash ratio available as of that date: ingest holdings, TEFAS (NAV/AUM + allocation) and BIST prices first', code: 'NO_DATA', fundsSkipped: skipped.slice(0, 50) });
      const states = Object.fromEntries(state.registry.list().map((m) => [`${m.model_id}@${m.version}`, m.state]));
      const request = { seed: b.seed, engines, fundSystem: system, scenario: b.scenario || {}, options: b.options || {}, label: `from-data@${asOf}` };
      const bad = validateRequest(request); if (bad) return res.status(400).json({ error: bad });
      const out = recordRun(await runner(request, states), state.ledger);
      const meta = { asOf, funds: system.funds.length, assets: system.assets.length, fundsSkipped: skipped.slice(0, 200), unobservedLeverageFunds: system.funds.filter((f) => f.debt === null).length, source: 'ingested PIT observations (available_time <= asOf)' };
      await S.append('runs', { ...out.run, id: out.run.run_id, created_by: req.user.userCode, data: meta });
      await S.append('results', { id: out.run.run_id, results: out.results, claims: out.claims, created_by: req.user.userCode });
      for (const claimId of Object.values(out.claims)) await S.append('claim_owners', { id: claimId, created_by: req.user.userCode });
      await db.saveLedger(state.ledger);
      const byKey = {}; for (const r of out.results) byKey[r.engine] ||= r;
      res.status(201).json({ run: out.run, data: meta, production_status: out.production_status, non_production_models: out.non_production_models, results: out.results, claims: out.claims, retail_table: buildRetailRiskTable({ contagion: byKey.cascade, concentration: byKey.concentration }) });
    } catch (e) {
      if (e.code === 'BUSY') return res.status(429).json({ error: 'SFRE is busy, retry shortly' });
      if (e.code === 'TIMEOUT') return res.status(504).json({ error: 'run exceeded the time limit; reduce the request size' });
      logger.error({ err: e }, '[SFRE] from-data run failed');
      res.status(500).json({ error: 'internal error' });
    }
  });

  router.post('/runs/:id/narrative', analysisLimiter, requireRole(ROLES.ADMIN, ROLES.ANALYST), async (req, res) => {
    const rec = await S.get('results', req.params.id); if (!rec || !canRead(req, rec.created_by)) return res.status(404).json({ error: 'not found' });
    res.json(await explainResults({ results: rec.results, llm: explainLlm }));
  });

  return router;
}

// Default instance: PostgreSQL when DATABASE_URL is configured (same pool as the rest of BQI), memory otherwise.
let defaultRouter = null;
export default function sfreRouter(req, res, next) {
  if (!defaultRouter) {
    if (process.env.DATABASE_URL) {
      import('../services/database.js').then(({ query }) => { defaultRouter = createSfreRouter({ pg: query }); defaultRouter(req, res, next); }).catch(next);
      return;
    }
    defaultRouter = createSfreRouter();
  }
  defaultRouter(req, res, next);
}
