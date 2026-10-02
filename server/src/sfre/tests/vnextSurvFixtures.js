import { Rng } from '../core/prng.js';

export const T0 = Date.UTC(2025, 0, 6);
export const ASOF = new Date(T0 + 2e7).toISOString().replace(/\.\d{3}Z$/, 'Z');
export const DAY = 1e5; // synthetic session length (ms) so that many reference days fit in a short stream
let oidSeq = 0;

/** Seeded, pattern-free background market. Returns {reference, events, rng}. */
export function market(seed, { participants = 30, refOrders = 8000, evOrders = 4000, instruments = ['AAA'], venue = 'V1' } = {}) {
  const r = new Rng(seed); const P = Array.from({ length: participants }, (_, i) => `P${i}`);
  const gen = (t0, t1, n) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const ts = T0 + t0 + ((t1 - t0) * (i + r.next())) / n; const p = P[r.int(P.length)]; const side = r.next() < 0.5 ? 'B' : 'S'; const instrument = instruments[r.int(instruments.length)];
      const price = 100 + Math.round(10 * (r.next() - 0.5)) / 10; const qty = Math.round(50 + 450 * r.next() ** 2); const id = `o${++oidSeq}`;
      out.push({ ts, action: 'NEW', venue, instrument, orderId: id, participant: p, side, price, qty });
      const u = r.next();
      if (u < 0.25) { const c = P[(P.indexOf(p) + 1 + r.int(P.length - 1)) % P.length]; out.push({ ts: ts + 5 + r.next() * 2000, action: 'TRADE', venue, instrument, price, qty: Math.min(qty, 10 + r.int(100)), buyer: side === 'B' ? p : c, seller: side === 'B' ? c : p, buyOrderId: side === 'B' ? id : undefined, sellOrderId: side === 'S' ? id : undefined }); }
      else if (u < 0.5) out.push({ ts: ts + (r.next() < 0.03 ? 100 + r.next() * 800 : 1500 + r.next() * 60000), action: 'CANCEL', venue, instrument, orderId: id, participant: p });
    }
    return out;
  };
  return { reference: gen(0, 3e6, refOrders), events: gen(4e6, 5e6, evOrders), rng: r, participants: P };
}

export const newOrder = (ts, participant, side, price, qty, o = {}) => { const id = `x${++oidSeq}`; return [{ ts, action: 'NEW', venue: o.venue ?? 'V1', instrument: o.instrument ?? 'AAA', orderId: id, participant, side, price, qty }, id]; };
export const cancel = (ts, id, participant, o = {}) => ({ ts, action: 'CANCEL', venue: o.venue ?? 'V1', instrument: o.instrument ?? 'AAA', orderId: id, participant });
export const trade = (ts, buyer, seller, qty, price = 100, o = {}) => ({ ts, action: 'TRADE', venue: o.venue ?? 'V1', instrument: o.instrument ?? 'AAA', price, qty, buyer, seller, ...o.extra });

export const spoofEpisodes = (p, n, startMs = 4.1e6, o = {}) => {
  const ev = [];
  for (let i = 0; i < n; i++) { const t = T0 + startMs + i * 90000; const [no, id] = newOrder(t, p, 'B', 99, 3000, o); ev.push(no, cancel(t + 400, id, p, o), trade(t + 1500, 'PX' + i, p, 50, 100, o)); }
  return ev;
};
export const layeringEpisodes = (p, n, startMs = 4.2e6) => {
  const ev = [];
  for (let i = 0; i < n; i++) { const t = T0 + startMs + i * 95000; const ids = []; for (let l = 0; l < 4; l++) { const [no, id] = newOrder(t + l * 200, p, 'S', 100.5 + l * 0.1, 400); ev.push(no); ids.push(id); } ids.forEach((id, l) => ev.push(cancel(t + 1500 + l * 100, id, p))); ev.push(trade(t + 2500, p, 'PY' + i, 60, 100)); }
  return ev;
};
export const base = (m, extra = [], o = {}) => ({ asOf: ASOF, referenceEvents: m.reference, events: [...m.events, ...extra], salt: 'test-salt', ...o });
