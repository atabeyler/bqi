import { createHash } from 'node:crypto';

/**
 * Canonical JSON: sorted keys, no whitespace, finite numbers only. Same
 * logical value => same bytes => same hash, regardless of key order.
 * NaN/Infinity/undefined-in-arrays are rejected rather than silently
 * serialized to null (which would let two different computations collide).
 */
export function canonicalJson(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`canonicalJson: non-finite number ${value}`);
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'undefined':
      throw new Error('canonicalJson: undefined');
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
      const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof value}`);
  }
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function hashOf(value) {
  return sha256(canonicalJson(value));
}

/** Recursively freezes plain data. Returns the same object. */
export function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const k of Object.keys(obj)) deepFreeze(obj[k]);
  }
  return obj;
}

export function deepClone(obj) {
  return obj === undefined ? undefined : JSON.parse(JSON.stringify(obj));
}
