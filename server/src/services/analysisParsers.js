/**
 * Parsers for the structured tables (scenario probability matrix,
 * transaction ledger, optimization problem) the AI is asked to produce
 * inside its markdown report, plus the shape checks for the equivalent
 * user-uploaded real-data payloads. Split out of routes/analysis.js — these
 * are pure functions with no route/request coupling, and the most
 * format-fragile code in the analysis flow (LLM markdown output), so they
 * carry their own dedicated test file (analysis.parsers.test.js).
 */

export function isRealTransactionArray(v) {
  return Array.isArray(v) && v.length >= 3 && v.every((t) => t && typeof t.amount !== 'undefined');
}

export function isRealScenarioArray(v) {
  return Array.isArray(v) && v.length >= 2 && v.every((s) => s && s.title && typeof s.probability !== 'undefined');
}

export function isRealOptimizationProblem(v) {
  return v && Array.isArray(v.items) && v.items.length >= 2 && v.items.every((it) => it && typeof it.value !== 'undefined' && typeof it.cost !== 'undefined');
}

// Parses a number that may be in Turkish notation ("." thousands separator,
// "," decimal separator, e.g. "15.000,50") as well as plain notation.
// Only treats "." as a thousands separator when it's unambiguous — either a
// "," decimal separator is also present, or the whole string is a pure
// digit-grouping ("15.000") with no fractional remainder — so ordinary
// decimals like "0.5" are left untouched.
export function toNumber(s) {
  let str = String(s).replace(/[^\d.,-]/g, '').trim();
  if (!str) return 0;
  const hasComma = str.includes(',');
  const hasDot = str.includes('.');
  if (hasComma && hasDot) {
    str = str.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    str = str.replace(',', '.');
  } else if (hasDot && /^-?\d{1,3}(\.\d{3})+$/.test(str)) {
    str = str.replace(/\./g, '');
  }
  const n = parseFloat(str);
  return Number.isFinite(n) ? n : 0;
}

export function parseScenarios(content) {
  try {
    const scenarios = [];
    // "MATR.S." (wildcard for İ/I) avoids depending on a literal diacritic
    // character matching byte-for-byte against whatever encoding the LLM
    // used for the Turkish İ in "MATRİSİ".
    const matrixMatch = content.match(/KUANTUM OLASILIK MATR.S.[\s\S]*?\|([^\n]+)\|([^\n]+)\|([^\n]+)\|([^\n]+)\|([\s\S]*?)(?=\n##|\n---|\n\n##|$)/i);
    if (!matrixMatch) return null;

    // The AI sometimes wraps the scenario cell in markdown bold
    // ("| **SENARYO-A...** | ..."), which a plain startsWith('| SENARYO')
    // check misses entirely -- silently dropping every scenario row and
    // disabling the quantum computation for the whole report. Tolerate
    // leading emphasis markers, and strip them from every cell so ids/
    // titles don't carry literal asterisks through to the UI or the
    // Qiskit worker payload.
    const lines = content.split('\n').filter(l => /^\|\s*\*{0,2}SENARYO/.test(l.trim()));
    for (const line of lines) {
      const parts = line.split('|').map(s => s.trim().replace(/\*+/g, '')).filter(Boolean);
      if (parts.length >= 3) {
        scenarios.push({
          id: parts[0].split(' ')[0] + ' ' + (parts[0].split(' ')[1] || ''),
          title: parts[0],
          probability: parts[1],
          timeframe: parts[2],
          trigger: parts[3] || ''
        });
      }
    }
    return scenarios.length > 0 ? scenarios : null;
  } catch {
    return null;
  }
}

export function parseTransactions(content) {
  try {
    const transactions = [];
    // "LEM KAYITLARI" (drops the leading İ/I/Ş/S entirely) sidesteps both the
    // diacritic-encoding risk above AND the İŞLEM (with Ş) vs. an ASCII
    // "ISLEM" transliteration mismatch.
    const tableMatch = content.match(/LEM KAYITLARI[\s\S]*?\|([^\n]+)\|([^\n]+)\|([^\n]+)\|([^\n]+)\|([^\n]+)\|([^\n]+)\|([\s\S]*?)(?=\n##|\n---|\n\n##|$)/i);
    if (!tableMatch) return null;

    // Same emphasis-marker tolerance as parseScenarios below -- the AI can
    // wrap the row's leading cell in markdown bold.
    const lines = content.split('\n').filter(l => /^\|\s*\*{0,2}TXN/.test(l.trim()));
    for (const line of lines) {
      const parts = line.split('|').map(s => s.trim().replace(/\*+/g, '')).filter(Boolean);
      if (parts.length >= 6) {
        transactions.push({
          id: parts[0],
          amount: toNumber(parts[1]),
          hour: toNumber(parts[2]),
          frequency: toNumber(parts[3]),
          newCounterparty: toNumber(parts[4]),
          crossBorder: toNumber(parts[5]),
        });
      }
    }
    return transactions.length > 0 ? transactions : null;
  } catch {
    return null;
  }
}

export function parseOptimizationProblem(content) {
  try {
    // "OPT.M.ZASYON PROBLEM" (wildcards for the İ/I in "OPTİMİZASYON", drops
    // the trailing İ) sidesteps the diacritic mojibake risk -- same
    // reasoning as parseScenarios' "MATR.S." and parseTransactions'
    // "LEM KAYITLARI". This previously used a literal ASCII "OPTIMIZASYON",
    // but the AI's actual uppercase Turkish text uses İ (U+0130), which is
    // NOT case-fold-equivalent to ASCII I/i -- so the heading never
    // matched and this parser always returned null in production.
    const headingIdx = content.search(/OPT.M.ZASYON PROBLEM/i);
    if (headingIdx === -1) return null;

    // Bounded by the next section heading (like the other parsers), with a
    // generous cap so a missing heading marker can't run away indefinitely.
    const rest = content.slice(headingIdx);
    const endMatch = rest.match(/\n##|\n---|\n\n##/);
    const section = rest.slice(0, Math.min(endMatch ? endMatch.index : rest.length, 8000));

    // Prefer a "%N" that appears near the word "bütçe" so an unrelated
    // percentage mentioned earlier in the section isn't mistaken for it.
    const budgetMatch = section.match(/b[üu]tçe[^%]{0,40}%\s*(\d+(?:[.,]\d+)?)/i)
      || section.match(/%\s*(\d+(?:[.,]\d+)?)[^%]{0,40}b[üu]tçe/i)
      || section.match(/%\s*(\d+(?:[.,]\d+)?)/);
    const budgetPercent = budgetMatch ? toNumber(budgetMatch[1]) : 60;

    const lines = section.split('\n').filter(l => l.trim().startsWith('|'));
    const items = [];
    for (const line of lines) {
      const parts = line.split('|').map(s => s.trim().replace(/\*+/g, '')).filter(Boolean);
      if (parts.length < 3) continue;
      if (/^-+$/.test(parts[1])) continue; // separator row
      if (toNumber(parts[1]) === 0 && toNumber(parts[2]) === 0) continue; // header row
      items.push({ id: parts[0], value: toNumber(parts[1]), cost: toNumber(parts[2]) });
    }

    return items.length >= 2 ? { budgetPercent, items } : null;
  } catch {
    return null;
  }
}
