import { readWorkbook, mapColumns, num, parseDay, mkObs, normHeader, DAY } from './parse.js';

export const DEFAULT_LAG_DAYS = 1; // TEFAS history has no publication timestamp: conservative T+1 availability (ESTIMATED flag set)
const SOURCE = 'tefas:tarihsel';
const GENERAL = {
  date: { aliases: ['tarih'], required: true }, code: { aliases: ['fon kodu'], required: true },
  price: { aliases: ['fiyat'], required: true }, units: { aliases: ['tedavuldeki pay sayisi', 'pay sayisi'], required: false },
  investors: { aliases: ['kisi sayisi', 'yatirimci sayisi'], required: false }, aum: { aliases: ['fon toplam deger', 'portfoy buyuklugu', 'toplam deger'], required: false },
};
const CASH_LIKE = ['mevduat', 'repo', 'para piyasasi', 'takasbank', 'ters repo', 'vadeli mevduat'];
const EQUITY = ['hisse senedi'];

/**
 * TEFAS "Tarihsel Veriler" workbook (Genel Bilgiler + Portföy Dağılımı sheets, or CSV of either) -> PIT observations.
 * Never guesses: a sheet whose required columns are not found is reported in `skipped` and nothing is invented.
 * cash_ratio = sum of observed cash-like allocation columns (VENDOR_DERIVED); null when none observed. Leverage is never emitted (UNOBSERVED).
 */
export function importTefas(buffer, { lagDays = DEFAULT_LAG_DAYS, ingestedMs = Date.now() } = {}) {
  const sheets = readWorkbook(buffer); const obs = []; const skipped = []; const report = { rows: 0, funds: new Set() };
  const series = new Map(); // code -> Map(dayMs -> {price, units, aum})
  for (const [name, rows] of Object.entries(sheets)) {
    if (rows.length < 2) continue;
    const g = mapColumns(rows[0], GENERAL);
    const isAlloc = !g.missing.length ? false : rows[0].some((h) => [...CASH_LIKE, ...EQUITY].some((a) => normHeader(h).includes(a)));
    if (!g.missing.length) {
      for (const r of rows.slice(1)) {
        const day = parseDay(r[g.idx.date]); const code = String(r[g.idx.code] ?? '').trim().toUpperCase(); const price = num(r[g.idx.price]);
        if (day === null || !code) continue;
        report.rows++; report.funds.add(code);
        const availableMs = day + lagDays * DAY; const ent = `FUND:${code}`;
        const emit = (field, value, unit) => { if (value !== null) obs.push(mkObs({ entity: ent, field, value, unit, eventMs: day, availableMs, source: SOURCE, ingestedMs })); };
        emit('nav_price', price, 'TRY');
        if (g.idx.units !== undefined) emit('units', num(r[g.idx.units]), 'units');
        if (g.idx.investors !== undefined) emit('investors', num(r[g.idx.investors]), 'count');
        if (g.idx.aum !== undefined) emit('aum', num(r[g.idx.aum]), 'TRY');
        if (!series.has(code)) series.set(code, new Map());
        series.get(code).set(day, { price, units: g.idx.units !== undefined ? num(r[g.idx.units]) : null, aum: g.idx.aum !== undefined ? num(r[g.idx.aum]) : null });
      }
    } else if (isAlloc || rows[0].some((h) => normHeader(h) === 'fon kodu')) {
      const a = mapColumns(rows[0], { date: { aliases: ['tarih'], required: true }, code: { aliases: ['fon kodu'], required: true } });
      if (a.missing.length) { skipped.push({ sheet: name, reason: `missing ${a.missing.join(',')}` }); continue; }
      const headers = rows[0].map(normHeader);
      const cashCols = headers.map((h, i) => (CASH_LIKE.some((c) => h.includes(c)) ? i : -1)).filter((i) => i >= 0);
      const eqCols = headers.map((h, i) => (EQUITY.some((c) => h.includes(c)) ? i : -1)).filter((i) => i >= 0);
      for (const r of rows.slice(1)) {
        const day = parseDay(r[a.idx.date]); const code = String(r[a.idx.code] ?? '').trim().toUpperCase(); if (day === null || !code) continue;
        const availableMs = day + lagDays * DAY; const ent = `FUND:${code}`;
        const cash = cashCols.map((i) => num(r[i])).filter((x) => x !== null); const eq = eqCols.map((i) => num(r[i])).filter((x) => x !== null);
        if (cash.length) obs.push(mkObs({ entity: ent, field: 'cash_ratio', value: cash.reduce((s, x) => s + x, 0) / 100, unit: 'ratio', eventMs: day, availableMs, source: SOURCE, ingestedMs, flags: ['VENDOR_DERIVED'] }));
        if (eq.length) obs.push(mkObs({ entity: ent, field: 'equity_share', value: eq.reduce((s, x) => s + x, 0) / 100, unit: 'ratio', eventMs: day, availableMs, source: SOURCE, ingestedMs, flags: ['VENDOR_DERIVED'] }));
        report.rows++; report.funds.add(code);
      }
    } else skipped.push({ sheet: name, reason: `required columns not found: ${g.missing.join(',')}` });
  }
  // weekly net flow ratio = (units_t - units_{t-7}) * price_t / aum_{t-7}; only where all inputs are observed
  for (const [code, m] of series) {
    for (const [day, cur] of m) {
      const prev = m.get(day - 7 * DAY);
      if (!prev || cur.units === null || prev.units === null || cur.price === null || prev.aum === null || !(prev.aum > 0)) continue;
      obs.push(mkObs({ entity: `FUND:${code}`, field: 'net_flow_ratio', value: ((cur.units - prev.units) * cur.price) / prev.aum, unit: 'ratio', eventMs: day, availableMs: day + lagDays * DAY, source: SOURCE, ingestedMs, flags: ['VENDOR_DERIVED'] }));
    }
  }
  return { observations: obs, skipped, report: { rows: report.rows, funds: report.funds.size, observations: obs.length } };
}
