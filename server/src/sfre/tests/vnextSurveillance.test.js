import { describe, it, expect } from 'vitest';
import { runSurveillance, validateSurveillance, DETECTOR_NAMES } from '../engines/surveillance/index.js';
import { hashKey } from '../engines/surveillance/events.js';
import { market, base, spoofEpisodes, layeringEpisodes, newOrder, cancel, trade, T0, ASOF, DAY } from './vnextSurvFixtures.js';
import { STATUS } from '../core/result.js';

const byModel = (res, id) => res.find((r) => r.model_id === id);
const run = (s, o = {}) => runSurveillance(s, { seed: 1, ...o });

describe('M70 Market Surveillance 2.0', () => {
  it('NEGATIVE CONTROL: pattern-free background markets raise no pattern signal (5 seeds); every result is UNCALIBRATED and non-accusatory', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const res = run(base(market(seed)));
      for (const id of ['M70.spoofing', 'M70.layering', 'M70.wash_trading', 'M70.order_book_anomaly', 'M70.coordinated_trading']) { const r = byModel(res, id); expect(r.status, `seed ${seed} ${id}`).not.toBe(STATUS.SIGNAL); expect(r.calibration).toBe('UNCALIBRATED'); }
      for (const r of res) { expect(JSON.stringify(r)).not.toMatch(/manipulat|fraud|guilty|criminal/i); expect(r.status).not.toBe('LOW_RISK'); }
    }
  });
  it('SPOOFING-like: injected large, fast-cancelled, unfilled orders followed by opposite-side executions are flagged (hashed participant key, p below Bonferroni threshold)', () => {
    const m = market(2); const res = run(base(m, spoofEpisodes('P7', 9))); const r = byModel(res, 'M70.spoofing');
    expect(r.status).toBe(STATUS.SIGNAL); expect(r.value.label).toBe('SPOOFING_LIKE_PATTERN'); const f = r.value.findings[0];
    expect(f.participant).toBe(hashKey('test-salt', 'P7')); expect(f.participant).not.toContain('P7'); expect(f.pValue).toBeLessThan(f.bonferroniThreshold); expect(f.episodes).toBeGreaterThanOrEqual(9); expect(r.value.disclaimer).toMatch(/not an allegation/);
    expect(res.at(-1).value.signals.some((s) => s.model_id === 'M70.spoofing')).toBe(true);
  });
  it('LAYERING-like: stacked same-side orders at distinct price levels cancelled together with opposite execution are flagged', () => {
    const r = byModel(run(base(market(3), layeringEpisodes('P11', 8))), 'M70.layering'); expect(r.status).toBe(STATUS.SIGNAL); expect(r.value.findings[0].participant).toBe(hashKey('test-salt', 'P11')); expect(r.value.findings[0].maxLevels).toBeGreaterThanOrEqual(3);
  });
  it('WASH / SELF-MATCH: same-owner crosses and offsetting round trips are flagged (rule based); distinct owners are not', () => {
    const m = market(4); const t = T0 + 4.3e6;
    const self = [trade(t, 'W1', 'W2', 100, 100, { extra: { buyerOwner: 'OWN1', sellerOwner: 'OWN1' } })];
    const rt = []; for (let i = 0; i < 4; i++) { rt.push(trade(t + 1000 + i * 20000, 'W3', 'W4', 200)); rt.push(trade(t + 5000 + i * 20000, 'W4', 'W3', 200)); }
    const a = byModel(run(base(m, self)), 'M70.wash_trading'); expect(a.status).toBe(STATUS.SIGNAL); expect(a.value.findings[0].kind).toBe('SELF_MATCH');
    const b = byModel(run(base(m, rt)), 'M70.wash_trading'); expect(b.status).toBe(STATUS.SIGNAL); expect(b.value.findings.find((f) => f.kind === 'ROUND_TRIPS').roundTrips).toBeGreaterThanOrEqual(4);
    const c = byModel(run(base(m, [trade(t, 'W1', 'W2', 100, 100, { extra: { buyerOwner: 'OWN1', sellerOwner: 'OWN2' } })])), 'M70.wash_trading'); expect(c.status).toBe(STATUS.NO_SIGNAL);
    const d = byModel(run(base(m, [trade(t, 'L1', 'L2', 100)], { ownerGroups: { L1: 'G', L2: 'G' } })), 'M70.wash_trading'); expect(d.status).toBe(STATUS.SIGNAL);
  });
  it('MARKING-THE-CLOSE-like: a participant\'s close-window volume fraction far above its own reference days and aligned with the window price move is flagged', () => {
    const m = market(5, { refOrders: 6000, evOrders: 3000 }); const sessions = []; for (let d = 0; d < 30; d++) sessions.push({ day: `R${d}`, openTs: T0 + d * DAY, closeTs: T0 + (d + 1) * DAY });
    const evDay = 45; sessions.push({ day: 'E45', openTs: T0 + evDay * DAY, closeTs: T0 + (evDay + 1) * DAY });
    const extra = []; const cl = T0 + (evDay + 1) * DAY; // aggressive buying in the last 10% of the day while price ratchets up
    for (let i = 0; i < 12; i++) extra.push(trade(cl - 9000 + i * 700, 'MK', 'S' + i, 300, 100 + i * 0.1));
    extra.push(trade(T0 + evDay * DAY + 5000, 'MK', 'SX', 20, 99.5), trade(cl - 20000, 'A1', 'A2', 50, 99.6));
    // give MK a stable low close-window fraction in the reference days
    for (let d = 0; d < 30; d++) { const o = T0 + d * DAY; extra.push(trade(o + 10000, 'MK', 'R1', 100, 100), trade(o + 40000, 'R2', 'MK', 100, 100), trade(o + 50000 + (d % 5) * 1000, 'MK', 'R3', 80, 100), trade(o + 99000 - (d % 3) * 500, 'MK', 'R4', 10 + d % 4, 100)); }
    const s = base(m, [], { sessions, params: { close: { windowMs: 10000 } } }); s.referenceEvents = [...m.reference, ...extra.filter((e) => e.ts < T0 + 3e6)]; s.events = [...m.events, ...extra.filter((e) => e.ts >= T0 + 3e6)];
    const r = byModel(run(s), 'M70.marking_close'); expect(r.status).toBe(STATUS.SIGNAL); const f = r.value.findings.find((x) => x.participant === hashKey('test-salt', 'MK')); expect(f).toBeTruthy(); expect(f.robustZ).toBeGreaterThan(3.5); expect(f.netDirection).toBe(1);
  });
  it('ORDER-BOOK / MESSAGE anomalies: extreme cancel ratio, order-to-trade ratio and message bursts are flagged vs reference participants', () => {
    const m = market(6); const extra = []; const t = T0 + 4.5e6;
    for (let i = 0; i < 400; i++) { const [no, id] = newOrder(t + i * 3, 'Q9', i % 2 ? 'B' : 'S', 100 + (i % 7) * 0.1, 100); extra.push(no, cancel(t + i * 3 + 20, id, 'Q9')); }
    const r = byModel(run(base(m, extra)), 'M70.order_book_anomaly'); expect(r.status).toBe(STATUS.SIGNAL); const kinds = r.value.findings.filter((f) => f.participant === hashKey('test-salt', 'Q9')).map((f) => f.kind);
    expect(kinds).toContain('CANCELRATIO'); expect(kinds).toContain('SHORTLIFE'); expect(kinds).toContain('MESSAGE_BURST');
  });
  it('CROSS-VENUE / CROSS-MARKET: quick-cancelled large orders on one instrument with opposite executions in a LINKED instrument are flagged by a seeded permutation test; no links -> INSUFFICIENT_DATA', () => {
    const m = market(7, { instruments: ['ETF', 'FUT'] }); const extra = [];
    for (let i = 0; i < 9; i++) { const t = T0 + 4.1e6 + i * 80000; const [no, id] = newOrder(t, 'X1', 'B', 99, 4000, { instrument: 'ETF', venue: 'V1' }); extra.push(no, cancel(t + 300, id, 'X1', { instrument: 'ETF', venue: 'V1' }), trade(t + 900, 'Z' + i, 'X1', 60, 100, { instrument: 'FUT', venue: 'V2' })); }
    const s = base(m, extra, { instrumentLinks: [{ a: 'ETF', b: 'FUT' }] }); const r = byModel(run(s), 'M70.cross_venue'); expect(r.status).toBe(STATUS.SIGNAL); expect(r.value.findings[0].participant).toBe(hashKey('test-salt', 'X1')); expect(r.value.findings[0].pValue).toBeLessThan(0.01);
    expect(byModel(run(base(m, extra)), 'M70.cross_venue').status).toBe(STATUS.INSUFFICIENT_DATA);
    const nullRun = byModel(run(base(market(8, { instruments: ['ETF', 'FUT'] }), [], { instrumentLinks: [{ a: 'ETF', b: 'FUT' }] })), 'M70.cross_venue'); expect(nullRun.status).not.toBe(STATUS.SIGNAL);
  });
  it('COORDINATED TRADING: participants repeatedly trading the same instrument/direction in the same time bins form a cluster; background does not', () => {
    const m = market(9); const extra = []; const grp = ['K1', 'K2', 'K3', 'K4'];
    for (let b = 0; b < 25; b++) { const t = T0 + 4.0e6 + b * 35000; grp.forEach((p, i) => extra.push(trade(t + i * 300, p, 'CP' + ((b + i) % 7), 100 + 10 * i, 100))); }
    const r = byModel(run(base(m, extra)), 'M70.coordinated_trading'); expect(r.status).toBe(STATUS.SIGNAL); expect(r.value.findings[0].size).toBe(4); expect(r.value.findings[0].participants).toEqual(grp.map((g) => hashKey('test-salt', g)).sort());
    expect(byModel(run(base(market(10))), 'M70.coordinated_trading').status).toBe(STATUS.NO_SIGNAL);
  });
  it('PIT / look-ahead: events after asOf, reference not strictly before evaluation, and identity fields are all rejected loudly', () => {
    const m = market(2); expect(validateSurveillance(base(m, [], { asOf: new Date(T0 + 1e6).toISOString() }))).toMatch(/look-ahead/);
    const s = base(m); s.referenceEvents = [...m.reference, { ...m.events[0], ts: m.events[0].ts + 1, orderId: 'late', action: 'NEW', side: 'B', price: 1, qty: 1, participant: 'P1' }]; expect(validateSurveillance(s)).toMatch(/strictly precede/);
    for (const f of ['name', 'email', 'client_name', 'username']) { const bad = base(m); bad.events = [{ ...bad.events[0], [f]: 'x' }, ...bad.events.slice(1)]; expect(validateSurveillance(bad)).toMatch(/identity field/); const r = run(bad); expect(r[0].status).toBe(STATUS.COMPUTATION_FAILED); }
    expect(validateSurveillance(base(m, [], { asOf: 'garbage' }))).toMatch(/asOf/); expect(validateSurveillance({ ...base(m), events: [] })).toMatch(/required/); expect(validateSurveillance(base(m, [], { detectors: ['nope'] }))).toMatch(/subset/);
    const dup = base(m); dup.events = [...dup.events, dup.events[0]]; expect(validateSurveillance(dup)).toMatch(/duplicate NEW/); expect(validateSurveillance(base(m, [], { params: { spoof: { cancelWithinMs: -1 } } }))).toMatch(/positive/); expect(validateSurveillance(base(m, [], { params: { zzz: {} } }))).toMatch(/known detector/);
  });
  it('MISSING DATA: tiny reference windows give INSUFFICIENT_DATA (never NO_SIGNAL-as-safe); insufficient reasons are explicit', () => {
    const m = market(2, { refOrders: 60, evOrders: 200 }); const res = run(base(m)); const sp = byModel(res, 'M70.spoofing'); expect(sp.status).toBe(STATUS.INSUFFICIENT_DATA); expect(sp.value).toBeNull(); expect(sp.coverage.fraction).toBe(0); expect(sp.notes.join(' ')).toMatch(/reference has/);
    expect(res.at(-1).value.insufficient).toContain('M70.spoofing'); expect(byModel(res, 'M70.marking_close').status).toBe(STATUS.INSUFFICIENT_DATA);
  });
  it('is deterministic, salt-dependent in the pseudonym only, hashes both windows, and carries corroboration of other engines', () => {
    const m = market(2); const s = base(m, spoofEpisodes('P7', 9)); const a = run(s); const b = run(s); expect(a.map((r) => r.result_hash)).toEqual(b.map((r) => r.result_hash));
    const c = run({ ...s, salt: 'other' }); expect(byModel(c, 'M70.spoofing').value.findings[0].participant).not.toBe(byModel(a, 'M70.spoofing').value.findings[0].participant); expect(byModel(c, 'M70.spoofing').value.findings.length).toBe(byModel(a, 'M70.spoofing').value.findings.length);
    expect(a[0].input_hashes.length).toBe(2); const prior = [{ engine: 'integrity', model_id: 'M50.pump_dump_pattern', status: 'NO_SIGNAL', result_hash: 'h' }]; expect(run(s, { prior }).at(-1).value.corroboration[0].result_hash).toBe('h');
    expect(a.map((r) => r.model_id)).toEqual(expect.arrayContaining(DETECTOR_NAMES.length ? ['M70.spoofing', 'M70.surveillance_summary'] : []));
  });
  it('detector subset selection only runs requested detectors', () => {
    const r = run(base(market(2), [], { detectors: ['spoofing', 'wash'] })); expect(r.map((x) => x.model_id)).toEqual(['M70.spoofing', 'M70.wash_trading', 'M70.surveillance_summary']);
  });
  it('EMPIRICAL NULL BEHAVIOUR (synthetic only): over 20 pattern-free markets each detector raises at most 2 signals (nominal alpha 1%); this is NOT a real-world false-positive rate', () => {
    const counts = {};
    for (let seed = 200; seed < 220; seed++) for (const r of run(base(market(seed, { instruments: ['A', 'B'] }), [], { instrumentLinks: [{ a: 'A', b: 'B' }] }))) if (r.status === STATUS.SIGNAL) counts[r.model_id] = (counts[r.model_id] || 0) + 1;
    for (const [id, c] of Object.entries(counts)) expect(c, id).toBeLessThanOrEqual(2);
  }, 60000);
  it('ASOF is ISO', () => { expect(ASOF).toMatch(/Z$/); });
});
