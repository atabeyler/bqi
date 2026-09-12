import { createHash } from 'node:crypto';

// Deterministic key ordering so the same content always hashes the same,
// regardless of property insertion order (spec section 46/37: a hash is
// only useful for detecting tampering if it's stable for identical data).
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = canonicalize(value[key]);
        return acc;
      }, {});
  }
  return value;
}

export function hashContent(content) {
  // Hash the exact JSON value that is persisted. Query results can contain
  // Date instances; canonicalize(Date) used to turn them into {}, while the
  // INSERT serialization stored ISO strings. A valid, unchanged report then
  // failed verification after retrieval. The JSON round-trip applies the
  // same toJSON semantics as persistence before deterministic key ordering.
  const jsonValue = JSON.parse(JSON.stringify(content));
  const canonical = JSON.stringify(canonicalize(jsonValue));
  return createHash('sha256').update(canonical).digest('hex');
}
