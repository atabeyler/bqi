import { describe, it, expect } from 'vitest';
import { detectFxShocks, scoreEvents } from '../engines/fxShock.js';

const day = (i) => new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10);
function series(n, shockAt) { let v = 6; const out = []; for (let i = 0; i < n; i++) { v *= 1 + (i % 2 ? 0.002 : -0.0015) + (i === shockAt ? 0.1 : 0); out.push({ date: day(i), value: v }); } return out; }

describe('fx shock detector', () => {
  it('flags a +10% day against a calm history and nothing else', () => {
    const r = detectFxShocks(series(200, 150)); expect(r.flags.map((f) => f.date)).toEqual([day(150)]); expect(r.flags[0].move).toBeGreaterThan(0.09);
  });
  it('never flags during warm-up and uses only past data', () => {
    expect(detectFxShocks(series(200, 30)).flags).toEqual([]);
    const a = detectFxShocks(series(150, 120)); const b = detectFxShocks(series(200, 120)); expect(a.flags).toEqual(b.flags);
  });
  it('scores events with lead time and lists unmatched flags (false alarms)', () => {
    const flags = [{ date: day(150), move: 0.1, z: 9 }, { date: day(20), move: 0.05, z: 6 }];
    const r = scoreEvents(flags, [{ id: 'X', t0: day(151), name: 'x' }, { id: 'Y', t0: day(100), name: 'y' }]);
    expect(r.events[0]).toMatchObject({ detected: true, leadDays: 1 }); expect(r.events[1].detected).toBe(false); expect(r.unmatchedFlags).toHaveLength(1);
  });
});
