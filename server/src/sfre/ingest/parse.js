import * as XLSX from 'xlsx';
import { makeObservation } from '../data/observation.js';

const DAY = 86400000;
const TR = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };

/** header normalisation: lower-case, Turkish letters folded to ASCII, punctuation removed */
export const normHeader = (h) => String(h ?? '').toLocaleLowerCase('tr-TR').replace(/[çğıöşüâîû]/g, (c) => TR[c]).replace(/[^a-z0-9% ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Number or null. Empty / non-numeric is UNOBSERVED (null), never 0. Handles 1.234,56 and 1234.56. */
export function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v ?? '').trim().replace(/[%\s]/g, '');
  if (!s || s === '-') return null;
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** UTC-midnight ms from Excel serial, dd.mm.yyyy, or yyyy-mm-dd. null when unparseable. */
export function parseDay(v) {
  if (typeof v === 'number' && v > 20000 && v < 80000) { const p = XLSX.SSF.parse_date_code(v); return p ? Date.UTC(p.y, p.m - 1, p.d) : null; }
  if (v instanceof Date && !Number.isNaN(v.getTime())) return Date.UTC(v.getFullYear(), v.getMonth(), v.getDate());
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/); if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return null;
}

export const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** All sheets of a CSV/XLSX buffer -> {name: rows[][]} (row 0 = headers). */
export function readWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  return Object.fromEntries(wb.SheetNames.map((n) => [n, XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '', raw: true })]));
}

/** Maps required/optional logical columns to header indexes by alias lists. Returns {idx, missing}. */
export function mapColumns(headers, spec) {
  const h = headers.map(normHeader); const idx = {}; const used = new Set();
  // pass 1: exact alias match; pass 2: substring match among still-unused columns (a column can serve only one logical field)
  for (const exact of [true, false]) {
    for (const [key, { aliases }] of Object.entries(spec)) {
      if (idx[key] !== undefined) continue;
      const i = h.findIndex((x, k) => !used.has(k) && aliases.some((a) => (exact ? x === a : x.includes(a))));
      if (i >= 0) { idx[key] = i; used.add(i); }
    }
  }
  const missing = Object.entries(spec).filter(([k, v]) => v.required && idx[k] === undefined).map(([k]) => k);
  return { idx, missing };
}

/**
 * Observation factory with the PIT contract. `availableMs` is when the fact could first have been known.
 * published_time defaults to available_time when the true publication time is unknown (conservative; flagged ESTIMATED).
 */
export function mkObs({ entity, field, value, unit = null, eventMs, availableMs, publishedMs = null, ingestedMs = Date.now(), source, flags = [] }) {
  const pub = publishedMs ?? availableMs; const ing = Math.max(ingestedMs, availableMs);
  return makeObservation({ entity, field, value, unit, event_time: iso(eventMs), published_time: iso(pub), available_time: iso(availableMs), ingested_time: iso(ing), source, revision: 0, quality_flags: [...new Set([...(publishedMs === null ? ['ESTIMATED'] : []), ...flags])] });
}
export { DAY };
