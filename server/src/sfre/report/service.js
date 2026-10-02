import { detectFxShocks } from '../engines/fxShock.js';
import { assessSituation, renderReportHtml, reportId, LEVELS, LEVEL_TR } from './situationReport.js';
import { archiveReport, archiveDailyIfDue } from './archive.js';
import { buildDocModel, snapshotOf } from './docModel.js';

export const REPORT_FX_SERIES = 'TP.DK.USD.A.YTL';
const RECENT_FX_DAYS = 120;
const dayIso = (d) => new Date(d).toISOString().slice(0, 10);

/** Reads the latest evidence from the database. `db` is a PgStore, `pg` its query function; both may be null (then the report says "no data"). */
export async function gatherReportInputs({ db, pg, registry, now = new Date() }) {
  let breadth = null; let fx = null; let coverage = [];
  if (db) {
    const docs = await db.list('federated', 50); // newest first
    breadth = docs.find((d) => /^breadth-trial/.test(d.title || '') && d.payload?.weeks)?.payload ?? null;
    const r = await pg(`SELECT to_char(event_time AT TIME ZONE 'UTC','YYYY-MM-DD') AS d, value FROM sfre_observations WHERE entity=$1 AND field='value' ORDER BY event_time`, [`EVDS:${REPORT_FX_SERIES}`]);
    const seen = new Map(); for (const x of r.rows) seen.set(x.d, Number(x.value));
    if (seen.size) {
      const pts = [...seen].map(([date, value]) => ({ date, value }));
      fx = { series: REPORT_FX_SERIES, flags: detectFxShocks(pts).flags, recent: pts.slice(-RECENT_FX_DAYS) };
    }
    const c = await pg('SELECT source, field, count(*)::int AS n, min(available_time) AS first, max(available_time) AS last FROM sfre_observations GROUP BY source, field ORDER BY source, field');
    coverage = c.rows.map((x) => ({ source: x.source, field: x.field, n: x.n, first: x.first ? dayIso(x.first) : '', last: x.last ? dayIso(x.last) : '' }));
  }
  const models = registry ? registry.list().map((m) => ({ id: m.model_id, state: m.state })) : [];
  return { breadth, fx, coverage, models, now };
}

export function buildReport(inputs, { version = null } = {}) {
  const now = inputs.now || new Date();
  const assessment = assessSituation({ breadth: inputs.breadth, fx: inputs.fx, now });
  const meta = { generatedAt: now.toISOString(), version, models: inputs.models, coverage: inputs.coverage, dataAsOf: assessment.breadth?.date ?? assessment.fx?.lastDate ?? null };
  meta.documentId = reportId(assessment, meta);
  const parts = { assessment, breadth: inputs.breadth, fx: inputs.fx, meta };
  return { assessment, html: renderReportHtml(parts), model: buildDocModel(parts), snapshot: snapshotOf(parts), meta };
}

/**
 * Sends an e-mail when the overall level CHANGED since the last notification (up or down), never for an unchanged level, so a long
 * alarm does not become a stream of identical mails. The last notified level is stored in the "alert_state" collection.
 * `send({subject, text, html, attachments})` is injected (e-mail in production, a fake in tests).
 */
/** Called after every sync round: one archived snapshot per day, then the level-change check (which also archives and may mail). */
export async function dailyArchiveAndNotify({ db, pg, registry, send, version = null, now = new Date() }) {
  if (!db) return { archived: false, reason: 'no database' };
  const report = buildReport(await gatherReportInputs({ db, pg, registry, now }), { version });
  const daily = await archiveDailyIfDue(db, { report, now });
  return { archived: !!daily, notify: await notifyIfChanged({ db, pg, registry, send, version, now }) };
}

export async function notifyIfChanged({ db, pg, registry, send, force = false, version = null, now = new Date() }) {
  if (!db) return { sent: false, reason: 'no database' };
  const inputs = await gatherReportInputs({ db, pg, registry, now }); const report = buildReport(inputs, { version }); const { assessment, html } = report;
  const last = (await db.list('alert_state', 1))[0] ?? null;
  const changed = !last || last.level !== assessment.level;
  if (changed) await archiveReport(db, { report, trigger: 'level-change', now });
  const first = !last && assessment.level === LEVELS.NORMAL; // first ever run at NORMAL: record it, do not mail
  if (!force && (!changed || first)) { if (first) await db.append('alert_state', { id: `st_${now.getTime()}`, level: assessment.level, at: now.toISOString() }); return { sent: false, reason: first ? 'baseline recorded' : 'level unchanged', level: assessment.levelTr }; }
  const dir = last ? (assessment.level > last.level ? 'yükseldi' : 'düştü') : 'ilk değerlendirme';
  const subject = `[BFI] Sistem seviyesi: ${assessment.levelTr}${last ? ` (${LEVEL_TR[last.level]} → ${assessment.levelTr})` : ''}`;
  const text = `BFI sistem seviyesi ${dir}: ${assessment.levelTr}.\n\n${assessment.drivers.map((d) => `- ${d}`).join('\n')}\n\nAyrıntılı rapor ektedir. Modeller henüz kalibre edilmemiştir; bu bildirim yatırım tavsiyesi değildir.`;
  await send({ subject, text, html: `<p><b>BFI sistem seviyesi ${dir}: ${assessment.levelTr}</b></p><ul>${assessment.drivers.map((d) => `<li>${d.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</li>`).join('')}</ul><p>Ayrıntılı rapor ektedir (tarayıcıda açıp yazdırarak PDF alabilirsiniz).</p><p style="color:#667085;font-size:12px">Modeller henüz kalibre edilmemiştir; bu bildirim yatırım tavsiyesi değildir.</p>`, attachments: [{ filename: `BFI-Durum-Raporu-${now.toISOString().slice(0, 10)}.html`, content: Buffer.from(html, 'utf8') }] });
  await db.append('alert_state', { id: `st_${now.getTime()}`, level: assessment.level, at: now.toISOString() });
  return { sent: true, level: assessment.levelTr, previous: last ? LEVEL_TR[last.level] : null };
}
