/**
 * Shared CSV/XLSX parsing helpers used by the "real data" upload paths
 * (transactionSource.js, scenarioDataSource.js) — column-alias lookup,
 * loose numeric/boolean coercion, and raw sheet-to-rows reading.
 */
import * as XLSX from 'xlsx';

export function normalizeHeader(h) {
  return String(h ?? '').trim().toLowerCase();
}

export function findColumn(headers, aliases) {
  return headers.findIndex((h) => aliases.includes(normalizeHeader(h)));
}

export function toBool01(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (['1', 'evet', 'yes', 'true', 'var'].includes(s)) return 1;
  if (['0', 'hayır', 'hayir', 'no', 'false', 'yok', ''].includes(s)) return 0;
  const n = Number(s);
  return Number.isFinite(n) && n !== 0 ? 1 : 0;
}

export function toNumber(v) {
  if (typeof v === 'number') return v;
  const n = Number(String(v ?? '').replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export function extractHour(timestampValue) {
  if (typeof timestampValue === 'number') {
    // XLSX serial date/time
    const parsed = XLSX.SSF.parse_date_code(timestampValue);
    if (parsed?.H !== undefined) return parsed.H;
  }
  const d = new Date(timestampValue);
  return Number.isNaN(d.getTime()) ? 0 : d.getHours();
}

/** Reads the first sheet of a CSV/XLSX buffer into an array of row arrays (row 0 = headers). */
export function readSheetRows(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
}

/** Fallback for a CSV/XLSX file that isn't a recognized structured table — flattened to plain-text CSV for use as generic document context. */
export function sheetToText(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  return XLSX.utils.sheet_to_csv(workbook.Sheets[workbook.SheetNames[0]]);
}
