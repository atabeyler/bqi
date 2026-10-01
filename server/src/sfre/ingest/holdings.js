import { readWorkbook, mapColumns, num, parseDay, mkObs, DAY } from './parse.js';

export const DEFAULT_HOLDINGS_LAG_DAYS = 10; // portfolio reports are published with a delay; operator must set the REAL lag per source
const COLS = {
  fund: { aliases: ['fon kodu', 'fon', 'fund'], required: true }, date: { aliases: ['tarih', 'donem', 'date'], required: true },
  ticker: { aliases: ['hisse kodu', 'sembol', 'menkul kiymet', 'ticker', 'kod'], required: true }, weight: { aliases: ['agirlik', 'portfoy orani', 'oran', 'weight'], required: true },
};

/**
 * Fund holdings table (fund, date, ticker, weight%) -> one `holdings` observation per fund/date with value "TICKER=w;TICKER=w" (w as fraction of NAV).
 * available_time = report date + lagDays (ESTIMATED unless the real publication time is supplied via `publishedMsOf`).
 */
export function importHoldings(buffer, { lagDays = DEFAULT_HOLDINGS_LAG_DAYS, ingestedMs = Date.now(), source = 'holdings:upload', publishedMsOf = null } = {}) {
  const obs = []; const skipped = []; let rows = 0; const groups = new Map();
  for (const [name, data] of Object.entries(readWorkbook(buffer))) {
    if (data.length < 2) continue;
    const c = mapColumns(data[0], COLS);
    if (c.missing.length) { skipped.push({ sheet: name, reason: `missing ${c.missing.join(',')}` }); continue; }
    for (const r of data.slice(1)) {
      const day = parseDay(r[c.idx.date]); const fund = String(r[c.idx.fund] ?? '').trim().toUpperCase(); const t = String(r[c.idx.ticker] ?? '').trim().toUpperCase(); const w = num(r[c.idx.weight]);
      if (day === null || !fund || !t || w === null) continue;
      rows++; const k = `${fund}|${day}`; if (!groups.has(k)) groups.set(k, { fund, day, items: [] }); groups.get(k).items.push([t, w / 100]);
    }
  }
  for (const g of groups.values()) {
    const pub = publishedMsOf ? publishedMsOf(g.fund, g.day) : null; const availableMs = pub ?? g.day + lagDays * DAY;
    obs.push(mkObs({ entity: `FUND:${g.fund}`, field: 'holdings', value: g.items.map(([t, w]) => `BIST:${t}=${w.toFixed(8)}`).join(';'), unit: 'weights', eventMs: g.day, availableMs, publishedMs: pub, source, ingestedMs }));
  }
  return { observations: obs, skipped, report: { rows, observations: obs.length } };
}
