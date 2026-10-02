import { describe, it, expect } from 'vitest';
import { archiveReport, listReports, getReport, deleteReport, archiveDailyIfDue } from '../report/archive.js';
import { buildReport, dailyArchiveAndNotify } from '../report/service.js';

function fakeDb() {
  const col = {};
  return { col, async list(c, n = 100) { return [...(col[c] || [])].reverse().slice(0, n); }, async get(c, id) { return (col[c] || []).find((r) => r.id === id) ?? null; }, async append(c, r) { if (!(col[c] ||= []).some((x) => x.id === r.id)) col[c].push(r); return r; } };
}
const trial = (b) => ({ funds: 910, alarmLevel: 0.104, baseline: { meanBreadth: 0.044, sdBreadth: 0.015 }, weeks: [{ date: '2026-09-18', breadth: b, flagged: b >= 0.104 }] });
const mk = (b, at) => buildReport({ breadth: trial(b), fx: null, coverage: [], models: [], now: new Date(at) });
const pg = async () => ({ rows: [] });

describe('report archive', () => {
  it('stores a report with its html, lists it without the body and opens it', async () => {
    const db = fakeDb(); const rec = await archiveReport(db, { report: mk(0.12, '2026-09-26T10:00:00Z'), by: 'U1' });
    expect(rec).toMatchObject({ level_tr: 'ALARM', trigger: 'manual', created_by: 'U1' }); expect(rec.html).toBeUndefined();
    const list = await listReports(db); expect(list).toHaveLength(1); expect(list[0].html).toBeUndefined();
    expect((await getReport(db, rec.id)).html).toContain('<!doctype html>');
  });
  it('soft-deletes: hidden from list and open, tombstone kept, repeat delete is a no-op', async () => {
    const db = fakeDb(); const a = await archiveReport(db, { report: mk(0.12, '2026-09-26T10:00:00Z') }); const b = await archiveReport(db, { report: mk(0.04, '2026-09-27T10:00:00Z') });
    expect(await deleteReport(db, { id: a.id, by: 'ADM' })).toBe(true);
    expect((await listReports(db)).map((r) => r.id)).toEqual([b.id]); expect(await getReport(db, a.id)).toBeNull();
    expect(db.col.reports).toHaveLength(2); expect(db.col.report_deleted[0]).toMatchObject({ report_id: a.id, deleted_by: 'ADM' });
    expect(await deleteReport(db, { id: a.id, by: 'ADM' })).toBe(false);
  });
  it('rejects malformed ids and unknown triggers', async () => {
    const db = fakeDb(); expect(await getReport(db, "rp_x'; DROP")).toBeNull(); expect(await getReport(db, '../etc')).toBeNull();
    await expect(archiveReport(db, { report: mk(0.04, '2026-09-26T10:00:00Z'), trigger: 'evil' })).rejects.toThrow();
  });
  it('keeps one automatic snapshot per day, even if that snapshot was deleted', async () => {
    const db = fakeDb(); const day = (h) => mk(0.04, `2026-09-26T${h}:00:00Z`); const now = (h) => new Date(`2026-09-26T${h}:00:00Z`);
    const first = await archiveDailyIfDue(db, { report: day('08'), now: now('08') }); expect(first.trigger).toBe('daily');
    expect(await archiveDailyIfDue(db, { report: day('12'), now: now('12') })).toBeNull();
    await deleteReport(db, { id: first.id, by: 'ADM' }); expect(await archiveDailyIfDue(db, { report: day('13'), now: now('13') })).toBeNull();
    expect(await archiveDailyIfDue(db, { report: mk(0.04, '2026-09-27T08:00:00Z'), now: new Date('2026-09-27T08:00:00Z') })).not.toBeNull();
  });
  it('a sync round archives the daily snapshot and a level change archives too', async () => {
    const db = fakeDb(); const sent = []; const send = async (m) => sent.push(m); const registry = { list: () => [] };
    db.col.federated = [{ title: 'breadth-trial-tefas', payload: trial(0.04) }];
    await dailyArchiveAndNotify({ db, pg, registry, send, now: new Date('2026-09-26T08:00:00Z') });
    db.col.federated = [{ title: 'breadth-trial-tefas', payload: trial(0.12) }];
    const r = await dailyArchiveAndNotify({ db, pg, registry, send, now: new Date('2026-09-26T09:00:00Z') });
    expect(r.archived).toBe(false); expect(r.notify).toMatchObject({ sent: true, level: 'ALARM' }); expect(sent).toHaveLength(1);
    expect((await listReports(db)).map((x) => x.trigger).sort()).toEqual(['daily', 'level-change']) // the 08:00 baseline shares its document id with the daily snapshot, so it is stored once;
  });
});
