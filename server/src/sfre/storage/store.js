import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Append-only store interface: append(collection, record) / get(collection, id) / list(collection). */
export class MemoryStore {
  #data = new Map();
  append(collection, record) {
    if (!record?.id && !record?.run_id && !record?.snapshot_id) throw new Error('record needs id|run_id|snapshot_id');
    if (!this.#data.has(collection)) this.#data.set(collection, []);
    this.#data.get(collection).push(JSON.parse(JSON.stringify(record)));
    return record;
  }
  list(collection) { return (this.#data.get(collection) || []).map((r) => JSON.parse(JSON.stringify(r))); }
  get(collection, id) { return this.list(collection).find((r) => (r.id || r.run_id || r.snapshot_id) === id) || null; }
}

/** JSONL file store: one file per collection; append-only; used for dev/single-node. Not a production DB. */
export class JsonlFileStore {
  constructor(dir) { this.dir = dir; mkdirSync(dir, { recursive: true }); }
  #file(c) { if (!/^[a-z_]+$/.test(c)) throw new Error('bad collection name'); return path.join(this.dir, `${c}.jsonl`); }
  append(collection, record) { appendFileSync(this.#file(collection), `${JSON.stringify(record)}\n`); return record; }
  list(collection) { const f = this.#file(collection); return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; }
  get(collection, id) { return this.list(collection).find((r) => (r.id || r.run_id || r.snapshot_id) === id) || null; }
}
