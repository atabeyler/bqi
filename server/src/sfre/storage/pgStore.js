import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PitStore } from '../data/pitStore.js';
import { validateObservation } from '../data/observation.js';
import { EvidenceLedger } from '../evidence/ledger.js';

const SCHEMA = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8');
const BATCH = 500;

/**
 * PostgreSQL persistence. `query(text, params)` is injected (services/database.js `query` in production,
 * a pg Pool in tests). Observations, records and the ledger are append-only (DB triggers + ON CONFLICT DO NOTHING).
 */
export class PgStore {
  constructor(query) { this.query = query; this.persistedLedger = 0; }

  async ensureSchema() { await this.query(SCHEMA); }

  /** Validates (hash + PIT times) then bulk-inserts; duplicates (same hash) are ignored. Returns {inserted, rejected}. */
  async addObservations(list) {
    const good = []; const rejected = [];
    for (const o of list) { const e = validateObservation(o); if (e.length) rejected.push({ id: o.id, errors: e }); else good.push(o); }
    let inserted = 0;
    for (let i = 0; i < good.length; i += BATCH) {
      const chunk = good.slice(i, i + BATCH); const params = []; const rows = chunk.map((o, k) => {
        const b = k * 13;
        params.push(o.hash, o.id, o.entity, o.field, JSON.stringify(o.value), o.unit, o.event_time, o.published_time, o.available_time, o.ingested_time, o.source, o.revision, o.quality_flags);
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5}::jsonb,$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13}::text[])`;
      });
      const r = await this.query(`INSERT INTO sfre_observations (hash,id,entity,field,value,unit,event_time,published_time,available_time,ingested_time,source,revision,quality_flags) VALUES ${rows.join(',')} ON CONFLICT (hash) DO NOTHING`, params);
      inserted += r.rowCount ?? 0;
    }
    return { inserted, duplicates: good.length - inserted, rejected };
  }

  /** Loads observations available at or before `asOfMax` into an in-memory PitStore (the firewall then applies per view). */
  async loadPitStore({ asOfMax, entityPrefix = null } = {}) {
    const r = await this.query(
      `SELECT hash,id,entity,field,value,unit,event_time,published_time,available_time,ingested_time,source,revision,quality_flags FROM sfre_observations WHERE available_time <= $1 ${entityPrefix ? 'AND entity LIKE $2' : ''} ORDER BY available_time`,
      entityPrefix ? [asOfMax, `${entityPrefix}%`] : [asOfMax]);
    const store = new PitStore();
    const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
    for (const x of r.rows) store.add({ hash: x.hash, id: x.id, entity: x.entity, field: x.field, value: x.value, unit: x.unit, event_time: iso(x.event_time), published_time: iso(x.published_time), available_time: iso(x.available_time), ingested_time: iso(x.ingested_time), source: x.source, revision: x.revision, quality_flags: x.quality_flags });
    return store;
  }

  async append(collection, record) {
    const id = record.id || record.run_id || record.snapshot_id;
    if (!id) throw new Error('record needs id|run_id|snapshot_id');
    await this.query('INSERT INTO sfre_records (collection,id,record) VALUES ($1,$2,$3::jsonb) ON CONFLICT (collection,id) DO NOTHING', [collection, id, JSON.stringify(record)]);
    return record;
  }

  async get(collection, id) {
    const r = await this.query('SELECT record FROM sfre_records WHERE collection=$1 AND id=$2', [collection, id]);
    return r.rows[0]?.record ?? null;
  }

  async list(collection, limit = 100) {
    const r = await this.query('SELECT record FROM sfre_records WHERE collection=$1 ORDER BY created_at DESC LIMIT $2', [collection, limit]);
    return r.rows.map((x) => x.record);
  }

  /** Persists ledger entries not yet stored. Idempotent; the chain is re-verified on load. */
  async saveLedger(ledger) {
    const entries = ledger.entries();
    for (let i = this.persistedLedger; i < entries.length; i++) {
      const e = entries[i];
      await this.query('INSERT INTO sfre_ledger (seq,id,entry,prev_hash,hash) VALUES ($1,$2,$3::jsonb,$4,$5) ON CONFLICT (seq) DO NOTHING', [e.seq, e.id, JSON.stringify(e), e.prev_hash, e.hash]);
    }
    this.persistedLedger = entries.length;
  }

  async loadLedger(opts = {}) {
    const r = await this.query('SELECT entry FROM sfre_ledger ORDER BY seq');
    const ledger = r.rows.length ? EvidenceLedger.import(r.rows.map((x) => x.entry), opts) : new EvidenceLedger(opts);
    this.persistedLedger = r.rows.length;
    return ledger;
  }

  async saveModels(registry) {
    for (const m of registry.exportState()) await this.query('INSERT INTO sfre_models (key,record) VALUES ($1,$2::jsonb) ON CONFLICT (key) DO UPDATE SET record=EXCLUDED.record, updated_at=now()', [`${m.model_id}@${m.version}`, JSON.stringify(m)]);
  }

  async loadModels() { return (await this.query('SELECT record FROM sfre_models')).rows.map((x) => x.record); }
}
