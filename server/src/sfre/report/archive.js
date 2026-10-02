/**
 * Report archive on top of the append-only record store. A report is stored once with its full HTML; "deleting" one appends a tombstone
 * (the database forbids rewriting records, which is also what keeps an audit trail), after which it no longer lists or opens.
 * Collections: "reports" (id rp_<documentId>) and "report_deleted" (id del_<reportId>).
 */
export const ARCHIVE_LIMIT = 100;
const TRIGGERS = new Set(['manual', 'daily', 'level-change']);

export async function archiveReport(db, { report, trigger = 'manual', by = null, now = new Date() }) {
  if (!TRIGGERS.has(trigger)) throw new Error(`unknown trigger ${trigger}`);
  const a = report.assessment;
  const id = `rp_${report.meta.documentId}`;
  const record = { id, document_id: report.meta.documentId, level: a.level, level_tr: a.levelTr, drivers: a.drivers, data_as_of: report.meta.dataAsOf, trigger, created_by: by, created_at: now.toISOString(), version: report.meta.version ?? null, html: report.html, data: report.snapshot ?? null };
  await db.append('reports', record);
  return strip(record);
}

const strip = ({ html, data, ...rest }) => { void html; return { ...rest, formats: data ? ['html', 'pdf', 'docx'] : ['html'] }; };

async function deletedIds(db) { return new Set((await db.list('report_deleted', 1000)).map((x) => x.report_id)); }

export async function listReports(db, limit = ARCHIVE_LIMIT) {
  const gone = await deletedIds(db);
  return (await db.list('reports', limit + gone.size)).filter((r) => !gone.has(r.id)).slice(0, limit).map(strip);
}

/** Returns the stored report (with html) or null when it does not exist or was deleted. */
export async function getReport(db, id) {
  if (!/^rp_[0-9A-F]{12}$/.test(id)) return null;
  if ((await deletedIds(db)).has(id)) return null;
  return (await db.get('reports', id)) ?? null;
}

export async function deleteReport(db, { id, by, now = new Date() }) {
  if (!(await getReport(db, id))) return false;
  await db.append('report_deleted', { id: `del_${id}`, report_id: id, deleted_by: by, deleted_at: now.toISOString() });
  return true;
}

/** At most one automatic daily snapshot per UTC day; returns the archived record or null when today already has one. */
export async function archiveDailyIfDue(db, { report, now = new Date() }) {
  const today = now.toISOString().slice(0, 10);
  // a deleted daily snapshot still counts: deleting it must not make the next sync recreate it
  if ((await db.list('reports', 20)).some((r) => r.trigger === 'daily' && String(r.created_at).slice(0, 10) === today)) return null;
  return archiveReport(db, { report, trigger: 'daily', now });
}
