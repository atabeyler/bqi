import { hashOf } from '../core/canonical.js';

export const QUALITY_FLAGS = Object.freeze([
  'ESTIMATED', 'RESTATED', 'STALE', 'SPLIT_UNADJUSTED', 'SPLIT_ADJUSTED', 'PROVISIONAL',
  'SYNTHETIC', 'LICENSE_RESTRICTED', 'VENDOR_DERIVED',
]);
const FLAG_SET = new Set(QUALITY_FLAGS);
const TIME_FIELDS = ['event_time', 'published_time', 'available_time', 'ingested_time'];
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function parseTime(s) {
  if (typeof s !== 'string' || !ISO_UTC.test(s)) return NaN;
  return Date.parse(s);
}

function contentOf(o) {
  return {
    entity: o.entity, field: o.field, value: o.value, unit: o.unit ?? null,
    event_time: o.event_time, published_time: o.published_time, available_time: o.available_time,
    // ingested_time is deliberately NOT part of the content hash: re-importing the same fact later must dedupe
    source: o.source, revision: o.revision, quality_flags: [...o.quality_flags].sort(),
  };
}

export function observationHash(o) {
  return hashOf(contentOf(o));
}

/** Builds a valid observation (computes hash/id). Throws on invalid input. */
export function makeObservation(input) {
  const o = {
    entity: input.entity,
    field: input.field,
    value: input.value === undefined ? null : input.value,
    unit: input.unit ?? null,
    event_time: input.event_time,
    published_time: input.published_time,
    available_time: input.available_time,
    ingested_time: input.ingested_time,
    source: input.source,
    revision: input.revision ?? 0,
    quality_flags: input.quality_flags ?? [],
  };
  const errs = validateObservationShape(o);
  if (errs.length) throw new Error(`invalid observation: ${errs.join('; ')}`);
  o.hash = observationHash(o);
  o.id = `obs_${o.hash.slice(0, 16)}`;
  return Object.freeze({ ...o, quality_flags: Object.freeze([...o.quality_flags]) });
}

export function validateObservationShape(o) {
  const errs = [];
  if (!o || typeof o !== 'object') return ['not an object'];
  if (typeof o.entity !== 'string' || !o.entity) errs.push('entity required');
  if (typeof o.field !== 'string' || !o.field) errs.push('field required');
  if (typeof o.source !== 'string' || !o.source) errs.push('source required');
  if (!(o.value === null || typeof o.value === 'string' || typeof o.value === 'boolean' || (typeof o.value === 'number' && Number.isFinite(o.value)))) errs.push('value must be finite number|string|boolean|null');
  for (const f of TIME_FIELDS) if (Number.isNaN(parseTime(o[f]))) errs.push(`${f} must be ISO-8601 UTC (…Z)`);
  if (!errs.length) {
    const p = parseTime(o.published_time); const a = parseTime(o.available_time); const i = parseTime(o.ingested_time);
    if (a < p) errs.push('available_time precedes published_time');
    if (i < a) errs.push('ingested_time precedes available_time');
  }
  if (!Number.isInteger(o.revision) || o.revision < 0) errs.push('revision must be integer >= 0');
  if (!Array.isArray(o.quality_flags) || o.quality_flags.some((f) => !FLAG_SET.has(f))) errs.push('unknown quality_flag');
  return errs;
}

/** Full validation of an externally supplied observation, including hash. */
export function validateObservation(o) {
  const errs = validateObservationShape(o);
  if (!errs.length) {
    if (o.hash !== observationHash(o)) errs.push('hash mismatch');
  }
  return errs;
}
