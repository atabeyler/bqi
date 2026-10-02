import { describe, it, expect } from 'vitest';
import { notifyIfChanged, buildReport } from '../report/service.js';

const NOW = new Date('2026-09-26T10:00:00Z');
const trial = (last) => ({ funds: 910, alarmLevel: 0.104, baseline: { meanBreadth: 0.044, sdBreadth: 0.015 }, weeks: [{ date: '2026-09-18', breadth: last, flagged: last >= 0.104 }] });
function fakeDb(initial = []) {
  const col = { alert_state: [...initial], federated: [] };
  return { col, set(t, payload) { col.federated = [{ title: t, payload }]; }, async list(c) { return [...(col[c] || [])].reverse(); }, async append(c, r) { (col[c] ||= []).push(r); return r; } };
}
const pg = async (sql) => (/FROM sfre_observations GROUP BY/.test(sql) ? { rows: [{ source: 'tefas', field: 'nav', n: 3, first: '2026-07-01', last: '2026-09-25' }] } : { rows: [] });
const registry = { list: () => [{ model_id: 'M21', state: 'DEVELOPMENT' }] };

describe('report notification', () => {
  it('records a baseline at NORMAL without mailing, and mails when the level changes', async () => {
    const db = fakeDb(); const sent = []; const send = async (m) => sent.push(m);
    db.set('breadth-trial-tefas', trial(0.04));
    expect(await notifyIfChanged({ db, pg, registry, send, now: NOW })).toMatchObject({ sent: false, reason: 'baseline recorded' });
    db.set('breadth-trial-tefas', trial(0.12));
    const r = await notifyIfChanged({ db, pg, registry, send, now: new Date(NOW.getTime() + 1000) });
    expect(r).toMatchObject({ sent: true, level: 'ALARM', previous: 'NORMAL' }); expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain('NORMAL → ALARM'); expect(sent[0].attachments[0].filename).toMatch(/^BFI-Durum-Raporu-.*\.html$/); expect(sent[0].attachments[0].content.toString()).toContain('ALARM');
  });
  it('does not repeat the same level, and mails again when it drops', async () => {
    const db = fakeDb(); const sent = []; const send = async (m) => sent.push(m);
    db.set('breadth-trial-tefas', trial(0.12));
    await notifyIfChanged({ db, pg, registry, send, now: NOW });
    expect(await notifyIfChanged({ db, pg, registry, send, now: new Date(NOW.getTime() + 1000) })).toMatchObject({ sent: false, reason: 'level unchanged' });
    db.set('breadth-trial-tefas', trial(0.04));
    expect((await notifyIfChanged({ db, pg, registry, send, now: new Date(NOW.getTime() + 2000) })).sent).toBe(true); expect(sent).toHaveLength(2); expect(sent[1].text).toContain('düştü');
  });
  it('does not record the new level when the mail fails, so the next run retries', async () => {
    const db = fakeDb([{ id: 'a', level: 0, at: 'x' }]); db.set('breadth-trial-tefas', trial(0.12));
    await expect(notifyIfChanged({ db, pg, registry, send: async () => { throw new Error('smtp down'); }, now: NOW })).rejects.toThrow('smtp down');
    expect(db.col.alert_state).toHaveLength(1);
  });
  it('builds a report without any database', () => { expect(buildReport({ breadth: null, fx: null, coverage: [], models: [], now: NOW }).html).toContain('Değerlendirilecek veri yok'); });
});
