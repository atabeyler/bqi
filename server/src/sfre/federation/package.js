import { createHmac, timingSafeEqual } from 'node:crypto';
import { hashOf } from '../core/canonical.js';

/**
 * BFI federation: a local node (big data, heavy compute) pushes only RESULTS to the cloud app.
 * A package is {docs:[{kind,title,summary,created_at,payload}]}. It is authenticated with HMAC-SHA256 over
 * `${timestamp}.${sha256(canonical JSON of the package)}`, so no raw body capture is needed and a replay older than MAX_SKEW_MS is refused.
 * Documents are content-addressed (id = hash of node + kind + payload): re-sending the same result is a harmless duplicate.
 */
export const MAX_DOC_BYTES = 200000;
export const MAX_DOCS = 50;
export const MAX_SKEW_MS = 10 * 60 * 1000;
export const MIN_SECRET_LENGTH = 32;
export const NODE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const KINDS = Object.freeze(['report', 'run', 'calibration', 'alert']);

export const signPackage = (body, secret, timestampMs) => createHmac('sha256', secret).update(`${timestampMs}.${hashOf(body)}`).digest('hex');

export function verifySignature(body, secret, timestampMs, signature, now = Date.now()) {
  if (!secret || secret.length < MIN_SECRET_LENGTH) return { ok: false, reason: 'NOT_CONFIGURED' };
  const ts = Number(timestampMs);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS) return { ok: false, reason: 'STALE_OR_BAD_TIMESTAMP' };
  const want = Buffer.from(signPackage(body, secret, ts), 'hex'); let got;
  try { got = Buffer.from(String(signature || ''), 'hex'); } catch { return { ok: false, reason: 'BAD_SIGNATURE' }; }
  return got.length === want.length && timingSafeEqual(got, want) ? { ok: true } : { ok: false, reason: 'BAD_SIGNATURE' };
}

/** Structural validation only (the HMAC proves who sent it, this proves it is small and well formed). */
export function validateDocs(body) {
  const docs = body?.docs;
  if (!Array.isArray(docs) || !docs.length) return 'docs must be a non-empty array';
  if (docs.length > MAX_DOCS) return `at most ${MAX_DOCS} documents per package`;
  for (const d of docs) {
    if (!d || typeof d !== 'object') return 'each document must be an object';
    if (!KINDS.includes(d.kind)) return `kind must be one of ${KINDS.join(',')}`;
    if (typeof d.title !== 'string' || !d.title || d.title.length > 200) return 'title is required (max 200 chars)';
    if (d.summary !== undefined && (typeof d.summary !== 'string' || d.summary.length > 1000)) return 'summary must be a string (max 1000 chars)';
    if (d.payload === undefined || JSON.stringify(d.payload).length > MAX_DOC_BYTES) return `payload is required and must be at most ${MAX_DOC_BYTES} bytes`;
    if (d.created_at !== undefined && Number.isNaN(Date.parse(d.created_at))) return 'created_at must be an ISO time';
  }
  return null;
}

export const docId = (node, doc) => `fed_${hashOf({ node, kind: doc.kind, payload: doc.payload }).slice(0, 32)}`;
