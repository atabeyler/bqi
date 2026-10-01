import { parseTime, validateObservation, makeObservation } from './observation.js';
import { hashOf, deepFreeze } from '../core/canonical.js';

export class LookAheadError extends Error {
  constructor(msg) { super(msg); this.name = 'LookAheadError'; }
}

/**
 * Append-only point-in-time store. Raw access is private; engines get a
 * PitView bound to a single asOf time. A view cannot be widened.
 */
export class PitStore {
  #obs = [];
  #byKey = new Map(); // `${entity}|${field}|${event_time}` -> observations (all revisions)

  add(input) {
    const o = input.hash && input.id ? input : makeObservation(input);
    const errs = validateObservation(o);
    if (errs.length) throw new Error(`PitStore.add rejected: ${errs.join('; ')}`);
    this.#obs.push(o);
    const key = `${o.entity}|${o.field}|${o.event_time}`;
    if (!this.#byKey.has(key)) this.#byKey.set(key, []);
    this.#byKey.get(key).push(o);
    return o;
  }

  addAll(list) { return list.map((o) => this.add(o)); }

  get size() { return this.#obs.length; }

  /** The firewall: only observations with available_time <= T are visible. */
  asOf(T) {
    const t = typeof T === 'number' ? T : parseTime(T);
    if (Number.isNaN(t)) throw new Error('asOf: invalid time');
    const visible = [];
    for (const versions of this.#byKey.values()) {
      let best = null;
      for (const o of versions) {
        if (parseTime(o.available_time) <= t && (!best || o.revision > best.revision)) best = o;
      }
      if (best) visible.push(best);
    }
    visible.sort((a, b) => parseTime(a.event_time) - parseTime(b.event_time) || (a.entity + a.field).localeCompare(b.entity + b.field));
    return new PitView(t, visible);
  }
}

export class PitView {
  #asOf; #obs;
  constructor(asOfMs, observations) {
    this.#asOf = asOfMs;
    this.#obs = Object.freeze(observations.slice());
  }

  get asOfMs() { return this.#asOf; }
  get asOfIso() { return new Date(this.#asOf).toISOString(); }
  get observations() { return this.#obs; }

  #index = null;

  series(entity, field) {
    if (!this.#index) {
      this.#index = new Map();
      for (const o of this.#obs) {
        const k = `${o.entity}|${o.field}`;
        if (!this.#index.has(k)) this.#index.set(k, []);
        this.#index.get(k).push({ t: parseTime(o.event_time), value: o.value, id: o.id, hash: o.hash });
      }
    }
    return (this.#index.get(`${entity}|${field}`) || []).slice();
  }

  latest(entity, field) {
    const s = this.series(entity, field);
    return s.length ? s[s.length - 1] : null;
  }

  entities(prefix = '') { return [...new Set(this.#obs.filter((o) => o.entity.startsWith(prefix)).map((o) => o.entity))].sort(); }
}

/** Runtime check used before every engine call in validation runs. */
export function assertNoFutureData(view, T) {
  const t = typeof T === 'number' ? T : parseTime(T);
  for (const o of view.observations) {
    if (parseTime(o.available_time) > t) throw new LookAheadError(`observation ${o.id} available at ${o.available_time} leaks into view as-of ${new Date(t).toISOString()}`);
  }
  if (view.asOfMs > t) throw new LookAheadError('view as-of is later than the evaluation time');
  return true;
}

/** Immutable, content-addressed dataset snapshot. */
export function createSnapshot(observations, { asOf, label = null } = {}) {
  const t = parseTime(asOf);
  if (Number.isNaN(t)) throw new Error('createSnapshot: asOf required (ISO-8601 UTC)');
  for (const o of observations) {
    if (parseTime(o.available_time) > t) throw new LookAheadError(`snapshot as-of ${asOf} contains later observation ${o.id}`);
    const errs = validateObservation(o);
    if (errs.length) throw new Error(`snapshot rejected observation: ${errs.join('; ')}`);
  }
  const sorted = observations.slice().sort((a, b) => a.hash.localeCompare(b.hash));
  const content_hash = hashOf(sorted.map((o) => o.hash));
  return deepFreeze({
    snapshot_id: `snap_${content_hash.slice(0, 16)}`,
    asOf, label, count: sorted.length, content_hash,
    observations: sorted.map((o) => ({ ...o, quality_flags: [...o.quality_flags] })),
  });
}

export function verifySnapshot(snap) {
  const hashes = snap.observations.map((o) => o.hash).slice().sort();
  const re = hashOf(hashes);
  const obsOk = snap.observations.every((o) => validateObservation(o).length === 0);
  return re === snap.content_hash && obsOk && snap.count === snap.observations.length;
}
