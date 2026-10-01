import { readWorkbook, mapColumns, num, parseDay, mkObs, DAY } from './parse.js';

const EOD_AVAILABLE_UTC_MS = 15.5 * 3600000; // 18:30 Europe/Istanbul (UTC+3): after the close and the closing-price publication
const EOD = {
  symbol: { aliases: ['sembol', 'kod', 'hisse kodu', 'symbol', 'menkul kiymet'], required: true }, date: { aliases: ['tarih', 'date'], required: true },
  close: { aliases: ['kapanis', 'close'], required: true }, open: { aliases: ['acilis', 'open'], required: false }, high: { aliases: ['en yuksek', 'yuksek', 'high'], required: false },
  low: { aliases: ['en dusuk', 'dusuk', 'low'], required: false }, volume: { aliases: ['hacim adet', 'islem miktari', 'adet', 'lot', 'volume'], required: false }, turnover: { aliases: ['hacim tl', 'islem hacmi', 'turnover', 'tutar'], required: false },
};
const FF = {
  symbol: { aliases: ['sembol', 'kod', 'hisse kodu', 'symbol'], required: true }, date: { aliases: ['tarih', 'date'], required: true },
  ratio: { aliases: ['fiili dolasim orani', 'fiili dolasim pay orani', 'free float ratio', 'orani'], required: false }, shares: { aliases: ['fiili dolasimdaki pay', 'fiili dolasim pay adedi', 'free float shares'], required: false },
  capital: { aliases: ['sermaye', 'odenmis sermaye', 'capital'], required: false },
};

const sym = (v) => String(v ?? '').trim().toUpperCase().replace(/\.E$/, '');

/** BIST end-of-day data (Borsa İstanbul DataStore / distributor export) -> close/open/high/low/volume/turnover observations. */
export function importBistEod(buffer, { ingestedMs = Date.now(), source = 'bist:eod' } = {}) {
  const obs = []; const skipped = []; let rows = 0;
  for (const [name, data] of Object.entries(readWorkbook(buffer))) {
    if (data.length < 2) continue;
    const c = mapColumns(data[0], EOD);
    if (c.missing.length) { skipped.push({ sheet: name, reason: `missing ${c.missing.join(',')}` }); continue; }
    for (const r of data.slice(1)) {
      const day = parseDay(r[c.idx.date]); const s = sym(r[c.idx.symbol]); if (day === null || !s) continue;
      rows++;
      const availableMs = day + EOD_AVAILABLE_UTC_MS;
      for (const [field, unit] of [['close', 'TRY'], ['open', 'TRY'], ['high', 'TRY'], ['low', 'TRY'], ['volume', 'shares'], ['turnover', 'TRY']]) {
        if (c.idx[field] === undefined) continue; const v = num(r[c.idx[field]]);
        if (v !== null) obs.push(mkObs({ entity: `BIST:${s}`, field, value: v, unit, eventMs: day, availableMs, source, ingestedMs }));
      }
    }
  }
  return { observations: obs, skipped, report: { rows, observations: obs.length } };
}

/**
 * Free-float report -> free_float_ratio (0-1) and free_float_shares. Shares are taken from the report when present;
 * otherwise derived as ratio x paid-in capital (nominal 1 TRY/share assumption, flagged ESTIMATED+VENDOR_DERIVED). Never guessed.
 */
export function importFreeFloat(buffer, { lagDays = 1, ingestedMs = Date.now(), source = 'bist:free_float' } = {}) {
  const obs = []; const skipped = []; let rows = 0;
  for (const [name, data] of Object.entries(readWorkbook(buffer))) {
    if (data.length < 2) continue;
    const c = mapColumns(data[0], FF);
    if (c.missing.length || (c.idx.ratio === undefined && c.idx.shares === undefined)) { skipped.push({ sheet: name, reason: 'symbol/date or ratio/shares columns not found' }); continue; }
    for (const r of data.slice(1)) {
      const day = parseDay(r[c.idx.date]); const s = sym(r[c.idx.symbol]); if (day === null || !s) continue;
      rows++;
      const availableMs = day + lagDays * DAY; const ent = `BIST:${s}`;
      let ratio = c.idx.ratio !== undefined ? num(r[c.idx.ratio]) : null; if (ratio !== null && ratio > 1) ratio /= 100;
      let shares = c.idx.shares !== undefined ? num(r[c.idx.shares]) : null; const cap = c.idx.capital !== undefined ? num(r[c.idx.capital]) : null;
      const flags = [];
      if (shares === null && ratio !== null && cap !== null) { shares = ratio * cap; flags.push('VENDOR_DERIVED'); }
      if (ratio !== null) obs.push(mkObs({ entity: ent, field: 'free_float_ratio', value: ratio, unit: 'ratio', eventMs: day, availableMs, source, ingestedMs }));
      if (shares !== null) obs.push(mkObs({ entity: ent, field: 'free_float_shares', value: shares, unit: 'shares', eventMs: day, availableMs, source, ingestedMs, flags }));
    }
  }
  return { observations: obs, skipped, report: { rows, observations: obs.length } };
}
