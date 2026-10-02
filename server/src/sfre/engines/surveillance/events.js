import { sha256 } from '../../core/canonical.js';
import { FORBIDDEN_FIELDS } from '../coordination.js';

export const ACTIONS = Object.freeze(['NEW', 'CANCEL', 'MODIFY', 'TRADE']);
// bounded by the 10 MB HTTP body limit of /api/sfre/runs; larger replays go through the CLI/worker path
export const LIMITS_SURV = Object.freeze({ events: 40000, referenceEvents: 60000 });
export const DISCLAIMER = 'Statistical pattern similarity only. This is not an allegation or finding of unlawful conduct by any person or firm; intent cannot be inferred from order-book data.';
const EXTRA_FORBIDDEN = ['client_name', 'account_name', 'person', 'trader_name', 'firm_name'];

/** Validates a message stream. Returns an error string or null. Identity-bearing fields are rejected (pseudonymous keys only). */
export function validateEvents(events, { label = 'events' } = {}) {
  if (!Array.isArray(events)) return `${label} must be an array`;
  const seenNew = new Set();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e || typeof e !== 'object') return `${label}[${i}] not an object`;
    for (const f of [...FORBIDDEN_FIELDS, ...EXTRA_FORBIDDEN]) if (f in e) return `${label}[${i}]: identity field "${f}" rejected (pseudonymous participant keys only)`;
    if (!Number.isFinite(e.ts)) return `${label}[${i}]: ts must be finite (epoch ms)`;
    if (!ACTIONS.includes(e.action)) return `${label}[${i}]: action must be ${ACTIONS.join('|')}`;
    if (!e.instrument || !e.venue) return `${label}[${i}]: instrument and venue required`;
    if (e.action === 'TRADE') {
      if (!e.buyer || !e.seller || !(e.price > 0) || !(e.qty > 0)) return `${label}[${i}]: TRADE needs buyer, seller, price>0, qty>0`;
    } else {
      if (!e.orderId || !e.participant) return `${label}[${i}]: orderId and participant required`;
      if (e.action === 'NEW') {
        if (!['B', 'S'].includes(e.side) || !(e.price > 0) || !(e.qty > 0)) return `${label}[${i}]: NEW needs side B|S, price>0, qty>0`;
        const k = `${e.venue}|${e.orderId}`; if (seenNew.has(k)) return `${label}[${i}]: duplicate NEW orderId ${e.orderId}`; seenNew.add(k);
      }
    }
  }
  return null;
}

/** Orders keyed `venue|orderId` with lifetime, cancel time and fills; plus the trade list. Deterministic ordering by (ts, index). */
export function indexEvents(events) {
  const sorted = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.ts - b.e.ts || a.i - b.i).map((x) => x.e);
  const orders = new Map(); const trades = [];
  for (const e of sorted) {
    const key = `${e.venue}|${e.orderId}`;
    if (e.action === 'NEW') orders.set(key, { key, participant: e.participant, venue: e.venue, instrument: e.instrument, side: e.side, price: e.price, qty: e.qty, ts: e.ts, cancelTs: null, filled: 0, owner: e.owner ?? null });
    else if (e.action === 'CANCEL') { const o = orders.get(key); if (o && o.cancelTs === null) o.cancelTs = e.ts; }
    else if (e.action === 'TRADE') {
      trades.push(e);
      for (const [oid, side] of [[e.buyOrderId, 'B'], [e.sellOrderId, 'S']]) { if (!oid) continue; const o = orders.get(`${e.venue}|${oid}`); if (o && o.side === side) o.filled += e.qty; }
    }
  }
  return { orders: [...orders.values()], trades, sorted };
}

export const hashKey = (salt, k) => sha256(`${salt}|${k}`).slice(0, 12);
export const groupBy = (arr, keyFn) => { const m = new Map(); for (const x of arr) { const k = keyFn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };

/** Fills of a participant: from TRADE events (buyer/seller keys). */
export function participantFills(trades) {
  const fills = [];
  for (const t of trades) { fills.push({ participant: t.buyer, side: 'B', ts: t.ts, instrument: t.instrument, venue: t.venue, price: t.price, qty: t.qty, owner: t.buyerOwner ?? null }); fills.push({ participant: t.seller, side: 'S', ts: t.ts, instrument: t.instrument, venue: t.venue, price: t.price, qty: t.qty, owner: t.sellerOwner ?? null }); }
  return fills;
}
