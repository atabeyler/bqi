/**
 * Malware-scan / CDR (Content Disarm & Reconstruction) integration hook for
 * uploaded files (BQI-013). This project doesn't embed an antivirus engine
 * itself (a full ClamAV/CDR install is a heavy, environment-specific
 * dependency, not something to vendor into the app) -- instead this is a
 * thin, optional webhook contract a production deployment can point at
 * whatever scanner it already runs (a ClamAV REST wrapper, a CDR gateway,
 * a cloud AV API, ...).
 *
 * Unconfigured (no FILE_SCAN_WEBHOOK_URL): scanning is a no-op pass, exactly
 * matching this project's previous behavior -- uploads keep working exactly
 * as before for any deployment that hasn't set this up yet.
 *
 * Configured: every upload is POSTed to the webhook as
 * `{ filename, mimetype, size, sha256 }` (the file's hash, not its full
 * bytes, keeps this cheap and avoids sending file content to a third
 * service unless that service is specifically designed to receive it --
 * a real ClamAV/CDR wrapper matches on hash against its own signature/
 * quarantine database, or fetches the file itself via a separate,
 * deployment-specific channel). The webhook is expected to respond
 * `{ clean: true }` or `{ clean: false, reason: "..." }`; anything else
 * (non-2xx, timeout, malformed response) is treated as a scan failure.
 *
 * Fail-open vs fail-closed depends on data classification (BQI-013): a
 * scan failure (not a positive detection -- an infrastructure/timeout
 * failure) is allowed through for PUBLIC/INTERNAL uploads (matching this
 * project's existing tolerance for degraded-but-available service, see
 * quantum/AI provider fallback elsewhere), but rejected for CONFIDENTIAL/
 * RESTRICTED uploads, where an unverified file is a bigger risk than a
 * blocked upload. A positive detection (`clean: false`) is always
 * rejected, regardless of classification.
 */
import crypto from 'crypto';
import { logger } from './logger.js';

const SCAN_TIMEOUT_MS = 8000;
const HIGH_SENSITIVITY_CLASSIFICATIONS = new Set(['CONFIDENTIAL', 'RESTRICTED']);

export function isFileScanConfigured() {
  return !!process.env.FILE_SCAN_WEBHOOK_URL;
}

/**
 * @param {Buffer} buffer
 * @param {{filename?: string, mimetype?: string, classification?: string}} meta
 * @returns {Promise<{ok: boolean, reason: string, scanned: boolean}>}
 *          ok=false means: reject the upload. `reason` is always present
 *          (for audit logging), even when ok=true.
 */
export async function scanFile(buffer, { filename = '', mimetype = '', classification = 'INTERNAL' } = {}) {
  const webhookUrl = process.env.FILE_SCAN_WEBHOOK_URL;
  const highSensitivity = HIGH_SENSITIVITY_CLASSIFICATIONS.has(classification);
  if (!webhookUrl) {
    // Same fail-open/fail-closed split as the "scan unavailable" catch
    // branch below -- a deployment that never configured a scanner is
    // indistinguishable from one whose scanner is down, from the uploaded
    // file's perspective. A CONFIDENTIAL/RESTRICTED upload must not sail
    // through unscanned just because nobody set FILE_SCAN_WEBHOOK_URL yet.
    if (highSensitivity) {
      return { ok: false, scanned: false, reason: `no malware scanner configured (FILE_SCAN_WEBHOOK_URL unset) -- rejecting ${classification} upload as a precaution` };
    }
    return { ok: true, scanned: false, reason: 'not configured (FILE_SCAN_WEBHOOK_URL unset)' };
  }

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, mimetype, size: buffer.length, sha256 }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      throw new Error(`scan webhook returned HTTP ${res.status}`);
    }
    const body = await res.json();
    if (typeof body?.clean !== 'boolean') {
      throw new Error('scan webhook returned a malformed response');
    }
    if (!body.clean) {
      return { ok: false, scanned: true, reason: body.reason || 'flagged by malware scan' };
    }
    return { ok: true, scanned: true, reason: 'clean' };
  } catch (err) {
    logger.warn({ err, filename, classification }, '[FileScan] Scan request failed');
    // A positive detection above always rejects; only an infrastructure
    // failure (network/timeout/malformed response) reaches here, and only
    // for that case does classification decide fail-open vs fail-closed.
    if (highSensitivity) {
      return { ok: false, scanned: false, reason: `scan unavailable, rejecting ${classification} upload as a precaution: ${err.message}` };
    }
    return { ok: true, scanned: false, reason: `scan unavailable, allowed (classification=${classification}): ${err.message}` };
  }
}
