import { hashOf, deepFreeze } from '../core/canonical.js';

export const NODE_KINDS = Object.freeze(['CLAIM', 'ENGINE_RUN', 'MODEL', 'PARAMETERS', 'INPUT', 'SOURCE']);
const GENESIS = '0'.repeat(64);

/**
 * Append-only, hash-chained evidence graph:
 *   CLAIM -> ENGINE_RUN -> MODEL/EQUATION -> PARAMETERS -> INPUT DATA -> SOURCE -> TIMESTAMP -> HASH
 * `explain(claimId)` answers "why did BQI say this" from the graph, never from an LLM.
 * Wall-clock time lives on entries (`recorded_at`, from an injectable clock) but is excluded from node ids.
 */
export class EvidenceLedger {
  #entries = [];
  #nodes = new Map();
  #clock;

  constructor({ clock = () => new Date().toISOString() } = {}) { this.#clock = clock; }

  #append(kind, payload, edges = []) {
    const id = `${kind.toLowerCase()}_${hashOf({ kind, payload }).slice(0, 20)}`;
    if (this.#nodes.has(id)) return id; // content-addressed: identical node is stored once
    const prev = this.#entries.length ? this.#entries[this.#entries.length - 1].hash : GENESIS;
    const body = { seq: this.#entries.length, id, kind, payload, edges, recorded_at: this.#clock(), prev_hash: prev };
    const entry = deepFreeze({ ...body, hash: hashOf(body) });
    this.#entries.push(entry); this.#nodes.set(id, entry);
    return id;
  }

  /** Records a full provenance chain for one engine result and a human-facing claim bound to it. Returns claim id. */
  recordClaim({ claim, result, snapshot = null, sources = [], equationRef = null }) {
    const sourceIds = sources.map((s) => this.#append('SOURCE', { source: s.source, url: s.url ?? null, publication_time: s.publication_time ?? null, retrieval_time: s.retrieval_time ?? null, hash: s.hash ?? null }));
    const inputIds = [];
    if (snapshot) inputIds.push(this.#append('INPUT', { snapshot_id: snapshot.snapshot_id, content_hash: snapshot.content_hash, asOf: snapshot.asOf, count: snapshot.count }, sourceIds));
    for (const h of result.input_hashes || []) inputIds.push(this.#append('INPUT', { input_hash: h }, sourceIds));
    const paramId = this.#append('PARAMETERS', { parameter_hash: result.parameter_hash, parameters: result.parameters, calibration: result.calibration }, inputIds);
    const modelId = this.#append('MODEL', { model_id: result.model_id, model_version: result.model_version, equation_ref: equationRef || `MATHEMATICAL_SPECIFICATION#${result.model_id}` }, [paramId]);
    const runId = this.#append('ENGINE_RUN', { engine: result.engine, result_hash: result.result_hash, status: result.status, unobserved: result.unobserved }, [modelId]);
    return this.#append('CLAIM', { claim, result_hash: result.result_hash, status: result.status }, [runId]);
  }

  get(id) { return this.#nodes.get(id) || null; }
  get length() { return this.#entries.length; }
  entries() { return this.#entries.slice(); }

  /** Full evidence path for a claim (depth-first along edges). */
  explain(claimId) {
    const root = this.#nodes.get(claimId);
    if (!root || root.kind !== 'CLAIM') return null;
    const seen = new Set(); const path = [];
    const walk = (id) => { if (seen.has(id)) return; seen.add(id); const n = this.#nodes.get(id); if (!n) return; path.push({ id: n.id, kind: n.kind, payload: n.payload, recorded_at: n.recorded_at, hash: n.hash }); for (const e of n.edges) walk(e); };
    walk(claimId);
    return { claim: root.payload.claim, status: root.payload.status, result_hash: root.payload.result_hash, chain_valid: this.verify().ok, path };
  }

  /** Recomputes the hash chain. Returns first broken link if any. */
  verify() {
    let prev = GENESIS;
    for (const e of this.#entries) {
      const { hash, ...body } = e;
      if (e.prev_hash !== prev) return { ok: false, brokenAt: e.seq, reason: 'prev_hash mismatch' };
      if (hashOf(body) !== hash) return { ok: false, brokenAt: e.seq, reason: 'entry hash mismatch' };
      prev = hash;
    }
    return { ok: true, length: this.#entries.length, head: prev };
  }

  /** Serializable copy for persistence/import. */
  export() { return this.#entries.map((e) => JSON.parse(JSON.stringify(e))); }

  static import(entries, opts = {}) {
    const l = new EvidenceLedger(opts);
    for (const e of entries) { l.#entries.push(deepFreeze(JSON.parse(JSON.stringify(e)))); l.#nodes.set(e.id, l.#entries[l.#entries.length - 1]); }
    const v = l.verify();
    if (!v.ok) throw new Error(`ledger import failed verification at seq ${v.brokenAt}: ${v.reason}`);
    return l;
  }
}
