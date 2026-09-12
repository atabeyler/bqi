/**
 * Real-data upload path for the non-fraud quantum modules (scenario
 * probability engine + resource-allocation optimizer). Mirrors
 * transactionSource.js: a CSV/XLSX recognized as a genuine scenario or
 * optimization table is parsed into the exact shape the AI would otherwise
 * have invented, so the quantum circuit scores real, user-supplied numbers
 * instead of an LLM guess. Same downstream pipeline either way.
 */
import { normalizeHeader, findColumn, toNumber, readSheetRows } from './tableParsing.js';

const MAX_ROWS = 500;

const SCENARIO_ALIASES = {
  title: ['senaryo', 'scenario', 'senaryo adı', 'senaryo adi'],
  probability: ['olasılık', 'olasilik', 'probability', 'olasılık (%)', 'olasilik (%)'],
  timeframe: ['zaman ufku', 'zaman ufuk', 'timeframe', 'zaman dilimi', 'zaman'],
  trigger: ['tetikleyici', 'kritik tetikleyici', 'trigger'],
};

const ITEM_ALIASES = {
  id: ['kalem', 'item', 'proje', 'kalem adı', 'kalem adi'],
  value: ['değer', 'deger', 'value'],
  cost: ['maliyet', 'cost'],
  budget: ['bütçe', 'butce', 'budget', 'bütçe (%)', 'butce (%)'],
};

function loadRows(buffer, filename) {
  const name = (filename || '').toLowerCase();
  if (!/\.(csv|xlsx|xls)$/.test(name)) return null;
  let rows;
  try {
    rows = readSheetRows(buffer);
  } catch {
    return null;
  }
  if (!rows.length) return null;
  const headers = rows[0].map(normalizeHeader);
  const allDataRows = rows.slice(1).filter((r) => r.some((c) => String(c).trim() !== ''));
  const dataRows = allDataRows.slice(0, MAX_ROWS);
  if (!dataRows.length) return null;
  return { headers, dataRows, totalRows: allDataRows.length };
}

/**
 * @returns {{ scenarios: Array, warnings: string[] } | null}
 *          null when the file isn't a recognizable scenario table.
 */
export function parseScenarioFile(buffer, filename) {
  const parsed = loadRows(buffer, filename);
  if (!parsed) return null;
  const { headers, dataRows, totalRows } = parsed;

  const titleCol = findColumn(headers, SCENARIO_ALIASES.title);
  const probCol = findColumn(headers, SCENARIO_ALIASES.probability);
  if (titleCol === -1 || probCol === -1) return null;

  const timeframeCol = findColumn(headers, SCENARIO_ALIASES.timeframe);
  const triggerCol = findColumn(headers, SCENARIO_ALIASES.trigger);

  const warnings = [];
  if (timeframeCol === -1) warnings.push('Zaman Ufku sütunu bulunamadı.');
  if (triggerCol === -1) warnings.push('Tetikleyici sütunu bulunamadı.');
  if (totalRows > MAX_ROWS) warnings.push(`Dosyada ${totalRows} senaryo var, ilk ${MAX_ROWS} tanesi işlendi.`);

  const scenarios = dataRows.map((row, i) => ({
    id: `SRC-${i + 1}`,
    title: String(row[titleCol] ?? `SENARYO-${i + 1}`).trim(),
    probability: `%${toNumber(row[probCol])}`,
    timeframe: timeframeCol !== -1 ? String(row[timeframeCol] ?? '').trim() : '',
    trigger: triggerCol !== -1 ? String(row[triggerCol] ?? '').trim() : '',
  }));

  return { scenarios, warnings };
}

/**
 * @returns {{ items: Array, budgetPercent: number, warnings: string[] } | null}
 *          null when the file isn't a recognizable optimization item table.
 */
export function parseOptimizationFile(buffer, filename) {
  const parsed = loadRows(buffer, filename);
  if (!parsed) return null;
  const { headers, dataRows, totalRows } = parsed;

  const idCol = findColumn(headers, ITEM_ALIASES.id);
  const valueCol = findColumn(headers, ITEM_ALIASES.value);
  const costCol = findColumn(headers, ITEM_ALIASES.cost);
  if (idCol === -1 || valueCol === -1 || costCol === -1) return null;

  const budgetCol = findColumn(headers, ITEM_ALIASES.budget);
  const warnings = [];
  if (budgetCol === -1) warnings.push('Bütçe sütunu bulunamadı — varsayılan %60 kullanıldı.');
  if (totalRows > MAX_ROWS) warnings.push(`Dosyada ${totalRows} kalem var, ilk ${MAX_ROWS} tanesi işlendi.`);

  const budgetPercent = budgetCol !== -1 ? toNumber(dataRows[0][budgetCol]) : 60;
  const items = dataRows.map((row, i) => ({
    id: String(row[idCol] ?? `Kalem-${i + 1}`).trim(),
    value: toNumber(row[valueCol]),
    cost: toNumber(row[costCol]),
  }));

  return { items, budgetPercent, warnings };
}
