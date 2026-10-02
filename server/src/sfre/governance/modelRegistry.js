import { hashOf } from '../core/canonical.js';

export const STATES = Object.freeze(['DEVELOPMENT', 'VALIDATION', 'SHADOW', 'APPROVED', 'RETIRED']);
export const USES = Object.freeze(['SCENARIO_ANALYSIS', 'ALARMING']);
const EDGES = {
  DEVELOPMENT: ['VALIDATION', 'RETIRED'],
  VALIDATION: ['SHADOW', 'DEVELOPMENT', 'RETIRED'],
  SHADOW: ['APPROVED', 'VALIDATION', 'DEVELOPMENT', 'RETIRED'],
  APPROVED: ['SHADOW', 'RETIRED'],
  RETIRED: [],
};
const HEX64 = /^[0-9a-f]{64}$/;
export const MIN_POSITIVE_EVENTS = 30;

export class GovernanceError extends Error {
  constructor(msg) { super(msg); this.name = 'GovernanceError'; }
}

/**
 * Model lifecycle registry. There is deliberately NO method that promotes a model by itself:
 * every transition needs an explicit actor and the evidence its target state requires.
 * APPROVED requires a distinct HUMAN approver (never kind:'system', never the proposer or the shadow sponsor).
 */
export class ModelRegistry {
  #models = new Map();

  register({ model_id, version, spec_ref, proposed_by }) {
    if (!model_id || !version || !spec_ref || !proposed_by) throw new GovernanceError('model_id, version, spec_ref, proposed_by required');
    const key = `${model_id}@${version}`;
    if (this.#models.has(key)) throw new GovernanceError(`${key} already registered`);
    const rec = { model_id, version, spec_ref, proposed_by, state: 'DEVELOPMENT', calibration: 'UNCALIBRATED', approved_use: null, history: [] };
    this.#models.set(key, rec);
    this.#log(rec, null, 'DEVELOPMENT', { id: proposed_by, kind: 'human' }, { registered: true });
    return this.get(model_id, version);
  }

  #log(rec, from, to, actor, evidence) {
    const prev = rec.history.length ? rec.history[rec.history.length - 1].hash : '0'.repeat(64);
    const body = { seq: rec.history.length, from, to, actor, evidence, prev_hash: prev };
    rec.history.push({ ...body, hash: hashOf(body) });
  }

  /** Serializable state (for persistence). History hash chains travel with each record. */
  exportState() { return [...this.#models.values()].map((r) => JSON.parse(JSON.stringify(r))); }

  /** Restores persisted state, verifying every model's history chain; refuses a tampered history. */
  loadState(records) {
    for (const r of records) {
      let prev = '0'.repeat(64);
      for (const h of r.history) { const { hash, ...body } = h; if (h.prev_hash !== prev || hashOf(body) !== hash) throw new GovernanceError(`persisted history of ${r.model_id}@${r.version} failed verification`); prev = hash; }
      this.#models.set(`${r.model_id}@${r.version}`, JSON.parse(JSON.stringify(r)));
    }
    return this;
  }

  get(model_id, version) {
    const rec = this.#models.get(`${model_id}@${version}`);
    return rec ? JSON.parse(JSON.stringify(rec)) : null;
  }

  list() { return [...this.#models.values()].map((r) => JSON.parse(JSON.stringify(r))); }

  transition(model_id, version, to, { actor, evidence = {} } = {}) {
    const rec = this.#models.get(`${model_id}@${version}`);
    if (!rec) throw new GovernanceError('unknown model');
    if (!STATES.includes(to)) throw new GovernanceError(`unknown state ${to}`);
    if (!actor?.id || !['human', 'system'].includes(actor.kind)) throw new GovernanceError('actor {id, kind: human|system} required');
    if (!EDGES[rec.state].includes(to)) throw new GovernanceError(`transition ${rec.state} -> ${to} not allowed`);
    if (to === 'VALIDATION' && !evidence.spec_ref) throw new GovernanceError('VALIDATION requires evidence.spec_ref');
    if (to === 'SHADOW') {
      if (!HEX64.test(evidence.validation_report_hash || '')) throw new GovernanceError('SHADOW requires evidence.validation_report_hash (sha256)');
      if (!['REAL', 'MIXED'].includes(evidence.validation_data_kind)) throw new GovernanceError('SHADOW requires validation on REAL or MIXED data; SYNTHETIC-only validation cannot advance a model');
    }
    if (to === 'APPROVED') {
      if (actor.kind !== 'human') throw new GovernanceError('only a human actor can approve');
      const shadowActor = [...rec.history].reverse().find((h) => h.to === 'SHADOW')?.actor?.id;
      if (actor.id === rec.proposed_by || actor.id === shadowActor) throw new GovernanceError('approver must differ from proposer and shadow sponsor');
      if (!HEX64.test(evidence.shadow_report_hash || '')) throw new GovernanceError('APPROVED requires evidence.shadow_report_hash');
      if (!USES.includes(evidence.approved_use)) throw new GovernanceError(`APPROVED requires evidence.approved_use in ${USES.join('|')}`);
      if (evidence.approved_use === 'ALARMING') {
        const ok = evidence.positive_events >= MIN_POSITIVE_EVENTS && evidence.negative_control_passed === true && evidence.locked_holdout_evaluated_once === true && HEX64.test(evidence.calibration_report_hash || '');
        if (!ok) throw new GovernanceError(`ALARMING use requires calibration report, >=${MIN_POSITIVE_EVENTS} real positive events, passed negative controls and a once-evaluated locked holdout`);
        rec.calibration = 'CALIBRATED';
      }
      rec.approved_use = evidence.approved_use;
    }
    if (rec.state === 'APPROVED' && to !== 'APPROVED') { rec.approved_use = null; if (rec.calibration === 'CALIBRATED') rec.calibration = 'UNCALIBRATED'; }
    const from = rec.state; rec.state = to;
    this.#log(rec, from, to, actor, evidence);
    return this.get(model_id, version);
  }

  /** True only for an APPROVED model whose approved use matches. Everything else is NON_PRODUCTION. */
  isProductionUse(model_id, version, use) {
    const r = this.#models.get(`${model_id}@${version}`);
    return !!r && r.state === 'APPROVED' && r.approved_use === use;
  }

  verifyHistory(model_id, version) {
    const r = this.#models.get(`${model_id}@${version}`);
    if (!r) return false;
    let prev = '0'.repeat(64);
    for (const h of r.history) { const { hash, ...body } = h; if (h.prev_hash !== prev || hashOf(body) !== hash) return false; prev = hash; }
    return true;
  }
}

export const SFRE_MODELS = Object.freeze([
  'M01.abnormal_return', 'M01.abnormal_volume', 'M01.amihud', 'M02.hhi', 'M02.free_float_exposure', 'M03.overlap', 'M04.dtl', 'M04.profile', 'M05.flow_sensitivity',
  'M06.leverage', 'M07.amihud_linear', 'M07.sqrt', 'M08.network', 'M10.cascade', 'M11.tail', 'M12.hmm', 'M13.reverse_stress', 'M15.counterfactual',
  'M20.anomaly_ensemble', 'M30.fundamentals', 'M31.valuation', 'M32.divergence', 'M33.accounting_quality', 'M40.disclosure_rules', 'M41.claim_vs_reality',
  'M50.pump_dump_pattern', 'M51.attention', 'M52.coordination',
  // vNext: systemic / cross-sector engines, Market Surveillance 2.0 and the Financial System Digital Twin (docs/sfre/VNEXT_SYSTEMIC.md)
  'M60.cross_sector', 'M61.fx_contagion', 'M62.sovereign_bank_corporate', 'M63.margin_collateral', 'M64.ccp_default_waterfall', 'M65.private_credit', 'M66.ai_crowding',
  'M67.operational_contagion', 'M68.climate_nature', 'M69.digital_assets',
  'M70.spoofing', 'M70.layering', 'M70.wash_trading', 'M70.marking_close', 'M70.order_book_anomaly', 'M70.cross_venue', 'M70.coordinated_trading', 'M70.surveillance_summary',
  'M71.system_twin',
]);
const specDoc = (id) => (/^M(6\d|7\d)\./.test(id) ? 'docs/sfre/VNEXT_SYSTEMIC.md' : 'docs/sfre/MATHEMATICAL_SPECIFICATION.md');

/** Registry with every shipped model registered at DEVELOPMENT; nothing starts above it. */
export function createDefaultRegistry(version = '1.0.0') {
  const reg = new ModelRegistry();
  for (const id of SFRE_MODELS) reg.register({ model_id: id, version, spec_ref: `${specDoc(id)}#${id}`, proposed_by: 'sfre-initial-implementation' });
  return reg;
}
