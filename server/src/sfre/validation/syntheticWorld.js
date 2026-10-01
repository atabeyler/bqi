import { Rng } from '../core/prng.js';
import { PitStore } from '../data/pitStore.js';

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Seeded SYNTHETIC fund world with injected crises, benign market shocks, and permanently-fragile-but-healthy funds
 * (hard negatives). Used ONLY to exercise the validation machinery. Every observation carries quality flag SYNTHETIC.
 * Observation lags: prices/volume +0d, weekly flows +1d, monthly holdings/cash/debt/aum +7d (point-in-time realism).
 */
export function generateWorld({ seed = 1, nFunds = 330, nAssets = 40, days = 700, nEvents = 10, fundsPerEvent = 3, precursorDays = 40, startMs = Date.UTC(2022, 0, 3), fragileHealthyShare = 0.1, firstEventDay = 300, lastEventDay = 680 } = {}) {
  const rng = new Rng(seed);
  const store = new PitStore();
  const add = (entity, field, value, unit, dayEvent, lagDays, extraFlags = []) => {
    const t = startMs + dayEvent * DAY; const avail = t + lagDays * DAY;
    store.add({ entity, field, value, unit, event_time: iso(t), published_time: iso(t), available_time: iso(avail), ingested_time: iso(avail), source: 'synthetic:world', revision: 0, quality_flags: ['SYNTHETIC', ...extraFlags] });
  };
  // assets
  const assets = Array.from({ length: nAssets }, (_, k) => ({ id: `BIST:S${String(k).padStart(2, '0')}`, adv: Math.exp(Math.log(4e5) + 1.1 * rng.normal()), sigma: 0.012 + 0.02 * rng.next(), beta: 0.6 + 0.8 * rng.next(), p0: 10 + 40 * rng.next() }));
  const order = assets.map((a, i) => [a.adv, i]).sort((x, y) => x[0] - y[0]);
  const illiquidSet = order.slice(0, Math.floor(nAssets / 3)).map((x) => x[1]); // lowest ADV third
  const liquidSet = order.slice(Math.floor(nAssets / 2)).map((x) => x[1]);
  // events
  const events = [];
  const eventFundIdx = new Set();
  for (let e = 0; e < nEvents; e++) {
    const day = Math.round(firstEventDay + ((lastEventDay - firstEventDay) * e) / Math.max(1, nEvents - 1));
    const members = [];
    while (members.length < fundsPerEvent) { const f = rng.int(nFunds); if (!eventFundIdx.has(f)) { eventFundIdx.add(f); members.push(f); } }
    events.push({ id: `EV${e + 1}`, day, funds: members, entities: members.map((f) => `FUND:F${String(f).padStart(3, '0')}`), event_time: startMs + day * DAY });
  }
  const eventOf = new Map(); events.forEach((ev) => ev.funds.forEach((f) => eventOf.set(f, ev)));
  // benign market shocks (hard negatives)
  const benign = []; for (let b = 0; b < 4; b++) benign.push({ start: 200 + Math.floor(rng.next() * (days - 260)), len: 6 });
  const inBenign = (d) => benign.some((b) => d >= b.start && d < b.start + b.len);
  // funds
  const funds = Array.from({ length: nFunds }, (_, i) => {
    const fragile = !eventOf.has(i) && rng.next() < fragileHealthyShare;
    const pool = fragile ? illiquidSet : liquidSet; const w = new Array(nAssets).fill(0);
    const k = Math.min(pool.length, 12 + rng.int(8));
    const picks = new Set(); while (picks.size < k) picks.add((fragile || rng.next() < 0.75) ? pool[rng.int(pool.length)] : rng.int(nAssets));
    let tot = 0; for (const a of picks) { const g = -Math.log(1 - rng.next()); w[a] = g; tot += g; }
    for (const a of picks) w[a] /= tot;
    return { id: `FUND:F${String(i).padStart(3, '0')}`, w, aum: Math.exp(Math.log(3e8) + 0.6 * rng.normal()), cash: 0.05 + 0.1 * rng.next(), debt: rng.next() < 0.4 ? 0.3 * rng.next() : null, fragile, event: eventOf.get(i) || null };
  });
  // target illiquid-heavy portfolios for event funds
  const targets = new Map();
  for (const f of funds) if (f.event) { const t = new Array(nAssets).fill(0); const picks = [...new Set(Array.from({ length: 8 }, () => illiquidSet[rng.int(illiquidSet.length)]))]; picks.forEach((a) => { t[a] = 1 / picks.length; }); targets.set(f.id, t); }
  // price/volume paths
  const px = assets.map((a) => [a.p0]);
  const marketR = [];
  for (let d = 1; d <= days; d++) {
    const common = 0.008 * rng.normal() + (inBenign(d) ? -0.012 : 0);
    marketR.push(common);
    assets.forEach((a, k) => {
      let r = a.beta * common + a.sigma * rng.normal();
      for (const ev of events) if (d >= ev.day && d < ev.day + 3 && illiquidSet.includes(k)) r -= 0.1;
      px[k].push(px[k][d - 1] * Math.exp(r));
    });
  }
  for (let d = 0; d <= days; d++) {
    assets.forEach((a, k) => {
      add(a.id, 'close', px[k][d], 'TRY', d, 0);
      add(a.id, 'volume', Math.round(a.adv * Math.exp(0.35 * rng.normal())), 'shares', d, 0);
    });
  }
  // fund observations
  const flowState = new Map(); funds.forEach((f) => flowState.set(f.id, 0));
  for (const f of funds) {
    for (let d = 0; d <= days; d++) {
      let w = f.w.slice(); let cash = f.cash;
      let prog = 0;
      if (f.event) { prog = Math.min(1, Math.max(0, (d - (f.event.day - precursorDays)) / precursorDays)); if (prog > 0) { const t = targets.get(f.id); w = w.map((x, a) => x * (1 - 0.7 * prog) + t[a] * 0.7 * prog); cash = f.cash * (1 - 0.8 * prog); } }
      if (d % 21 === 0) {
        const held = w.map((x, a) => (x > 0 ? `${a}:${(x * (1 - cash)).toFixed(6)}` : null)).filter(Boolean).join(',');
        add(f.id, 'holdings', held, 'weights', d, 7);
        add(f.id, 'cash_ratio', cash, 'ratio', d, 7);
        add(f.id, 'debt_ratio', f.debt, 'ratio', d, 7); // null => UNOBSERVED
        add(f.id, 'aum', f.aum, 'TRY', d, 7);
      }
      if (d % 7 === 0) {
        let flow = 0.002 + 0.008 * rng.normal();
        if (inBenign(d) || inBenign(d - 3)) flow -= 0.004;
        if (f.event && prog > 0 && d < f.event.day + 7) flow -= 0.03 * prog + 0.004;
        if (f.event && d >= f.event.day) flow -= 0.08;
        add(f.id, 'net_flow_ratio', flow, 'ratio', d, 1);
      }
    }
  }
  return {
    store, assets, funds: funds.map((f) => ({ id: f.id, fragileHealthy: f.fragile, event: f.event?.id ?? null })), events, benign: benign.map((b) => ({ startDay: b.start, endDay: b.start + b.len })),
    startMs, days, marketReturns: marketR, params: { seed, nFunds, nAssets, days, nEvents, fundsPerEvent, precursorDays }, dataKind: 'SYNTHETIC',
  };
}
