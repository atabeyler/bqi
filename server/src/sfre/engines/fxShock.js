/**
 * Daily FX shock detector: a day is a shock when its log return is >= `z` robust sigmas (median/MAD of the PRECEDING `window` returns only,
 * so no future data) and at least `minMove` in size. Pure function; the first `warmup` days never flag.
 */
export const FX_SHOCK_PARAMS = Object.freeze({ window: 250, warmup: 60, z: 5, minMove: 0.02 });
export const CATALOGUE_EVENTS = Object.freeze([
  { id: 'E1', t0: '2018-08-10', name: 'Ağustos 2018 kur şoku' }, { id: 'E3', t0: '2021-03-22', name: 'Ağbal görevden alınması' },
  { id: 'E4', t0: '2021-12-16', name: 'Aralık 2021 kur şoku' }, { id: 'E6', t0: '2023-05-15', name: '14 Mayıs 2023 seçimi' }, { id: 'E7', t0: '2025-03-19', name: 'İmamoğlu gözaltı dalgası' },
]);
const med = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const DAY = 86400000;

export function detectFxShocks(points, params = {}) {
  const p = { ...FX_SHOCK_PARAMS, ...params };
  const s = [...points].filter((x) => x && x.value > 0).sort((a, b) => (a.date < b.date ? -1 : 1));
  const rets = []; const flags = [];
  for (let i = 1; i < s.length; i++) {
    const r = Math.log(s[i].value / s[i - 1].value);
    const hist = rets.slice(-p.window);
    if (hist.length >= p.warmup) {
      const m = med(hist); const mad = med(hist.map((x) => Math.abs(x - m))) * 1.4826 || 1e-9;
      const z = (r - m) / mad;
      if (Math.abs(z) >= p.z && Math.abs(r) >= p.minMove) flags.push({ date: s[i].date, move: Math.exp(r) - 1, z: +z.toFixed(1) });
    }
    rets.push(r);
  }
  return { params: p, days: s.length, flags };
}

/** For each event: first flag within [t0-3d, t0+3d]; leadDays = t0 - flagDate (>0 early, 0 same day, <0 late). */
export function scoreEvents(flags, events = CATALOGUE_EVENTS, tol = 3) {
  const near = new Set(); const rows = events.map((e) => {
    const t = Date.parse(`${e.t0}T00:00:00Z`);
    const hit = flags.find((f) => Math.abs(Date.parse(`${f.date}T00:00:00Z`) - t) <= tol * DAY);
    if (hit) near.add(hit.date);
    return { ...e, detected: !!hit, flagDate: hit?.date ?? null, leadDays: hit ? Math.round((t - Date.parse(`${hit.date}T00:00:00Z`)) / DAY) : null, move: hit?.move ?? null };
  });
  const unmatched = flags.filter((f) => !events.some((e) => Math.abs(Date.parse(`${f.date}T00:00:00Z`) - Date.parse(`${e.t0}T00:00:00Z`)) <= tol * DAY));
  return { events: rows, unmatchedFlags: unmatched };
}
