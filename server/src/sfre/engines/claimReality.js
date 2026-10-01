import { makeResult, STATUS, CALIBRATION } from '../core/result.js';
import { parseTime } from '../data/observation.js';

const ENGINE = 'claimReality';
export const VERDICTS = Object.freeze(['CONFIRMED', 'PARTIALLY_CONFIRMED', 'DELAYED', 'NOT_CONFIRMED', 'CONTRADICTED', 'INSUFFICIENT_EVIDENCE']);

/**
 * claim: {claim_id, company, stated_time, type, deadline|null}
 * evidence: [{id, kind: CONFIRMS|CONTRADICTS, event_time, published_time, available_time, source, tier, realizedFraction?}]
 * sourceCoverage: {adequate: boolean, sourcesChecked: string[]}  (provided by the research layer)
 * Only evidence with available_time <= asOf is used (look-ahead firewall).
 */
export function evaluateClaim(claim, evidence, asOf, { sourceCoverage = { adequate: false, sourcesChecked: [] } } = {}) {
  const t = parseTime(asOf); const stated = parseTime(claim.stated_time);
  const visible = (evidence || []).filter((e) => parseTime(e.available_time) <= t && parseTime(e.published_time) >= stated);
  const hidden = (evidence || []).length - visible.length;
  const deadline = claim.deadline ? parseTime(claim.deadline) : null;
  const decisive = visible.filter((e) => e.kind === 'CONFIRMS' || e.kind === 'CONTRADICTS').sort((a, b) => parseTime(a.event_time) - parseTime(b.event_time));
  const corroboration = (list) => ({ independentSources: new Set(list.map((e) => e.source)).size, hasPrimary: list.some((e) => ['OFFICIAL_REGULATOR', 'COMPANY_IR', 'INDEPENDENT_AUDIT'].includes(e.tier)) });
  const out = (verdict, rule, used, extra = {}) => makeResult({
    engine: ENGINE, modelId: 'M41.claim_vs_reality', status: verdict === 'INSUFFICIENT_EVIDENCE' ? STATUS.INSUFFICIENT_DATA : STATUS.MEASURED,
    value: { claim_id: claim.claim_id, verdict, rule, evidence_ids: used.map((e) => e.id), corroboration: corroboration(used), asOf, evidenceExcludedByFirewall: hidden, ...extra },
    calibration: CALIBRATION.UNCALIBRATED, parameters: { rule }, inputHashes: used.map((e) => e.id),
  });

  if (decisive.length) {
    const last = decisive[decisive.length - 1];
    if (last.kind === 'CONTRADICTS') return out('CONTRADICTED', 'LATEST_DECISIVE_EVIDENCE_CONTRADICTS', decisive.filter((e) => e.kind === 'CONTRADICTS'));
    const confirms = decisive.filter((e) => e.kind === 'CONFIRMS');
    const full = confirms.find((e) => e.realizedFraction === undefined || e.realizedFraction >= 1);
    if (full) {
      if (deadline === null) return out('CONFIRMED', 'CONFIRMED_NO_DEADLINE_STATED', [full]);
      return parseTime(full.event_time) <= deadline ? out('CONFIRMED', 'CONFIRMED_ON_OR_BEFORE_DEADLINE', [full]) : out('DELAYED', 'CONFIRMED_AFTER_DEADLINE', [full], { delayDays: (parseTime(full.event_time) - deadline) / 86400000 });
    }
    const partial = confirms.filter((e) => e.realizedFraction > 0 && e.realizedFraction < 1);
    if (partial.length) return out('PARTIALLY_CONFIRMED', 'REALIZED_FRACTION_BELOW_PROMISE', partial, { realizedFraction: Math.max(...partial.map((e) => e.realizedFraction)) });
  }
  if (deadline === null) return out('INSUFFICIENT_EVIDENCE', 'NO_DEADLINE_STATED', [], { phase: 'UNSCHEDULED' });
  if (t <= deadline) return out('INSUFFICIENT_EVIDENCE', 'DEADLINE_NOT_REACHED', [], { phase: 'PENDING' });
  if (sourceCoverage.adequate) return out('NOT_CONFIRMED', 'DEADLINE_PASSED_NO_EVIDENCE_ADEQUATE_COVERAGE', [], { sourcesChecked: sourceCoverage.sourcesChecked });
  return out('INSUFFICIENT_EVIDENCE', 'INADEQUATE_SOURCE_COVERAGE', [], { phase: 'DEADLINE_PASSED', sourcesChecked: sourceCoverage.sourcesChecked });
}

/** Persistent claim ledger: claims are never forgotten; each evaluation is re-run as-of a date. */
export class ClaimLedger {
  #claims = new Map();
  register(claim) { if (!this.#claims.has(claim.claim_id)) this.#claims.set(claim.claim_id, Object.freeze({ ...claim })); return this.#claims.get(claim.claim_id); }
  list(asOf = null) { const t = asOf ? parseTime(asOf) : Infinity; return [...this.#claims.values()].filter((c) => parseTime(c.stated_time) <= t); }
  evaluateAll(evidenceByClaim, asOf, opts = {}) { return this.list(asOf).map((c) => evaluateClaim(c, evidenceByClaim[c.claim_id] || [], asOf, opts)); }
}
