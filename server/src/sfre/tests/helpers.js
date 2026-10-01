import { Rng } from '../core/prng.js';

export const T0 = Date.UTC(2025, 0, 6);
export const DAY = 86400000;
export const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function obs(overrides = {}) {
  const t = overrides.t ?? T0;
  return {
    entity: 'BIST:AAAA', field: 'close', value: 10, unit: 'TRY', event_time: iso(t), published_time: iso(t), available_time: iso(t), ingested_time: iso(t),
    source: 'test', revision: 0, quality_flags: [], ...overrides,
  };
}

/** Random fund system generator for property tests (seeded). */
export function randomSystem(seed, { nFunds = 6, nAssets = 8, withDebt = true, withClaims = true } = {}) {
  const r = new Rng(seed);
  const assets = Array.from({ length: nAssets }, (_, k) => ({ id: `A${k}`, price: 5 + 20 * r.next(), illiq: 1e-9 * (0.5 + 3 * r.next()) }));
  const funds = Array.from({ length: nFunds }, (_, i) => {
    const holdings = []; for (let k = 0; k < nAssets; k++) if (r.next() < 0.5) holdings.push({ asset: `A${k}`, shares: Math.round(1e6 * (0.2 + 3 * r.next())) });
    return {
      id: `F${i}`, cash: Math.round(2e6 * r.next()), debt: withDebt && r.next() < 0.5 ? Math.round(3e6 * r.next()) : null,
      marginRatio: withDebt ? 0.15 + 0.2 * r.next() : null, beta: r.next() < 0.7 ? 0.3 + 0.7 * r.next() : null, holdings,
      claims: withClaims && i > 0 && r.next() < 0.4 ? [{ counterparty: `F${(i + 1) % nFunds}`, amount: Math.round(5e5 * r.next()) }] : [],
    };
  });
  return { assets, funds, impact: { model: 'amihud-linear' } };
}
