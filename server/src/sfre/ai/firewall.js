import { hashOf, deepClone } from '../core/canonical.js';

const ADVICE = /(?<![\p{L}])(buy|sell|hold|accumulate|satın al|sat|al|tut)(?![\p{L}])/iu;
const ACCUSATION = /(dolandırıcı|manipülatör|hırsız|suçlu|manipulator|fraudster|fraud|scam|criminal|swindl|crook)/i;
const CERTAINTY = /(?<![\p{L}])(kesinlikle|certainly|definitely|guaranteed|proves?|kanıtlıyor|kanıtlamaktadır|undoubtedly)(?![\p{L}])/iu;
export const DISCLAIMER_TR = 'Bu çıktı yatırım tavsiyesi değildir; ölçülmüş anomali, belirsizlik ve veri kapsamını gösterir.';

/** Sanitized, typed view the AI is allowed to see: engine results only, no raw observations/documents. */
export function unwrapForAI(results) {
  return results.map((r) => ({ engine: r.engine, model_id: r.model_id, status: r.status, calibration: r.calibration, coverage: r.coverage, unobserved: r.unobserved, value: deepClone(r.value), uncertainty: deepClone(r.uncertainty), notes: r.notes }));
}

function collectNumbers(x, out = new Set()) {
  if (typeof x === 'number' && Number.isFinite(x)) out.add(x);
  else if (typeof x === 'string') for (const m of x.matchAll(/-?\d+(?:\.\d+)?/g)) out.add(Number(m[0]));
  else if (Array.isArray(x)) x.forEach((v) => collectNumbers(v, out));
  else if (x && typeof x === 'object') Object.values(x).forEach((v) => collectNumbers(v, out));
  return out;
}

const close = (a, b) => Math.abs(a - b) <= 1e-9 + 0.005 * Math.abs(b) + 0.5 * 10 ** -4; // display rounding tolerance (<=0.5%, or 4 dp)

/** Returns {ok, violations[]}. Every number must come from the typed results; every status label must be stated. */
export function validateNarrative(text, results) {
  const violations = [];
  const allowed = [...collectNumbers(unwrapForAI(results))];
  const cleaned = String(text)
    .replace(/\bM\d+\.[a-z_0-9]+/gi, ' ') // model ids
    .replace(/^\s*\d+[.)]\s+/gm, ' ') // list markers
    .replace(/\bBQI\b|\bSFRE\b|\bTR-FUND-\d{4}-\d+/g, ' ');
  for (const m of cleaned.matchAll(/%?\s*-?\d+(?:[.,]\d+)?\s*%?/g)) {
    const raw = m[0].trim(); const pct = raw.includes('%');
    const n = Number(raw.replace(/[%\s]/g, '').replace(',', '.'));
    const candidates = pct ? [n, n / 100] : [n];
    if (!candidates.some((c) => allowed.some((a) => close(c, a)))) violations.push({ rule: 'NUMBER_NOT_IN_RESULTS', detail: raw });
  }
  for (const r of results) if (!String(text).includes(r.status)) violations.push({ rule: 'STATUS_NOT_STATED', detail: `${r.model_id}:${r.status}` });
  if (ADVICE.test(text)) violations.push({ rule: 'INVESTMENT_ADVICE', detail: String(text).match(ADVICE)[0] });
  if (ACCUSATION.test(text)) violations.push({ rule: 'ACCUSATION', detail: String(text).match(ACCUSATION)[0] });
  if (CERTAINTY.test(text)) violations.push({ rule: 'CERTAINTY_UPGRADE', detail: String(text).match(CERTAINTY)[0] });
  return { ok: violations.length === 0, violations };
}

function scalarSummary(v) {
  if (!v || typeof v !== 'object') return [];
  return Object.entries(v).filter(([, x]) => typeof x === 'number' && Number.isFinite(x)).slice(0, 6).map(([k, x]) => `${k}=${Number(x.toPrecision(6))}`);
}

/** Deterministic narrative; contains only result-derived numbers and status labels. Used as the fallback. */
export function renderDeterministic(results) {
  const lines = results.map((r) => {
    const cov = r.coverage ? `coverage ${r.coverage.observed}/${r.coverage.total}` : 'coverage n/a';
    const un = r.unobserved?.length ? `; UNOBSERVED: ${r.unobserved.slice(0, 6).join(', ')}` : '';
    const sc = scalarSummary(r.value);
    return `- ${r.engine} (${r.model_id}): ${r.status}; calibration ${r.calibration}; ${cov}${un}${sc.length ? `; ${sc.join(', ')}` : ''}`;
  });
  return `${DISCLAIMER_TR}\n${lines.join('\n')}`;
}

/**
 * AI may only EXPLAIN validated results. Results are frozen/hash-checked around the LLM call; the narrative is validated;
 * any violation (or an LLM failure) discards the LLM text and returns the deterministic rendering.
 * `llm` is injected: async ({system, user}) => string.
 */
export async function explainResults({ results, llm }) {
  const before = hashOf(results.map((r) => r.result_hash));
  const typed = unwrapForAI(results);
  const system = 'You explain pre-computed engine results. Use ONLY numbers present in the JSON. State each result\'s status label verbatim. Never give investment advice, never accuse any person or company, never claim certainty beyond the stated status, never fill in UNOBSERVED values.';
  let text = null; let violations = [];
  try {
    if (typeof llm === 'function') {
      text = String(await llm({ system, user: JSON.stringify(typed) }));
      const v = validateNarrative(text, results);
      violations = v.violations;
      if (!v.ok) text = null;
    }
  } catch (e) { violations = [{ rule: 'LLM_ERROR', detail: String(e?.message || e).slice(0, 120) }]; text = null; }
  const after = hashOf(results.map((r) => r.result_hash));
  if (before !== after) throw new Error('AI firewall: results changed during explanation');
  return text
    ? { text, source: 'LLM_VALIDATED', violations: [], results_hash: after }
    : { text: renderDeterministic(results), source: 'DETERMINISTIC_FALLBACK', violations, results_hash: after };
}
