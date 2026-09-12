import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import os from 'node:os';

import { MODEL_SPEC, MODEL_TIERS } from './modelSpec.js';
import { checkDeviceCapability } from './deviceCapability.js';

// Real Local Model Manager for the desktop app: install-check, streamed
// download with checksum verification, remove, and a device-capability
// gate. No network access happens unless install()/download is explicitly
// called by the user (spec point 9/privacy) -- isModelInstalled()/
// checkCapability() only ever touch the local filesystem and os.* stats.
//
// `modelsDir` is always caller-supplied (desktop/main.js passes
// path.join(app.getPath('userData'), 'models')) so this module never
// imports Electron and stays unit-testable with a plain tmp dir.
export function createModelManager({ modelsDir, spec = MODEL_SPEC, fetchImpl } = {}) {
  if (!modelsDir) throw new Error('modelManager requires modelsDir');

  const modelPath = path.join(modelsDir, spec.filename);
  const tmpPath = `${modelPath}.download`;

  // Tracks the single in-flight downloadModel() call, if any, so
  // cancelDownload() (Settings > Local AI's "Durdur"/"İptal" buttons) can
  // reach into it. There is only ever one download at a time -- the
  // renderer's Download button disables itself while downloading is true.
  let activeDownload = null;

  function makeCancelError(deletePartial) {
    const err = new Error('İndirme durduruldu.');
    err.cancelled = true;
    err.deletePartial = deletePartial;
    return err;
  }

  // deletePartial: false pauses (keeps the .download file for the next
  // Range-resumed attempt, i.e. "Devam Et"); true also deletes it (a full
  // "İptal" back to a clean not-installed state).
  function cancelDownload({ deletePartial = false } = {}) {
    if (activeDownload) {
      activeDownload.cancelled = true;
      activeDownload.deletePartial = deletePartial;
      activeDownload.request?.destroy();
      activeDownload.out?.destroy?.();
      return { ok: true };
    }
    // Nothing in flight -- e.g. "İptal Et" clicked on an already-paused
    // ("Devam Et") download. There's no request to interrupt, but a
    // deletePartial request should still discard the leftover .download
    // file so the user can actually walk away from it instead of being
    // forced to resume first just so there's something to cancel.
    if (deletePartial && fs.existsSync(tmpPath)) {
      fs.rmSync(tmpPath, { force: true });
      return { ok: true };
    }
    return { ok: false, error: 'no_active_download' };
  }

  function isModelInstalled() {
    return fs.existsSync(modelPath);
  }

  function getPartialBytes() {
    return fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
  }

  async function sha256File(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('error', reject);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }

  async function verifyChecksum(filePath = modelPath) {
    if (!fs.existsSync(filePath)) return { ok: false, reason: 'missing' };
    const actual = await sha256File(filePath);
    return { ok: actual === spec.sha256, actual, expected: spec.sha256 };
  }

  // A connection that goes quiet mid-transfer (server/CDN hiccup, a
  // dropped Wi-Fi/VPN hop) without actually closing the socket previously
  // hung forever here: neither https.get's callback nor its 'error' event
  // ever fires again, so the downloadModel() promise below just never
  // settles -- no error, no progress, indefinitely (observed firsthand: a
  // ~1.6GB partial download sat with its last byte written 10+ minutes
  // earlier and nothing in the diagnostics log at all). http.ClientRequest's
  // own setTimeout(ms) tracks socket *inactivity* -- it resets on every byte
  // received, so a slow-but-still-flowing download is never affected, only
  // one that's gone genuinely silent. Firing it destroys the request, which
  // downloadModel()'s res.on('error', ...)/out.on('error', ...) handlers
  // below turn into an ordinary rejection -- same partial-bytes-preserved,
  // Range-resumable path as any other network failure, just reachable at
  // all instead of hanging forever.
  const STALL_TIMEOUT_MS = 45_000;

  // Follows redirects itself (Node's https doesn't) -- Hugging Face's
  // resolve/ URLs 302 to a signed CDN URL. Streams straight to a .download
  // temp file so a crash/interrupt mid-download never leaves a file at the
  // real modelPath that isModelInstalled() would wrongly treat as ready.
  function httpGetFollowingRedirects(url, onResponse, redirectsLeft = 5, headers = {}, onRequest) {
    const getFn = fetchImpl || https.get;
    const callback = (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        httpGetFollowingRedirects(res.headers.location, onResponse, redirectsLeft - 1, headers, onRequest);
        return;
      }
      onResponse(res);
    };
    const request = fetchImpl ? getFn(url, callback) : getFn(url, { headers }, callback);
    // Optional-chained: the fetchImpl test double is a plain EventEmitter
    // with no setTimeout method, and skipping the stall guard there is
    // exactly right -- tests simulate a stall by simply not pushing more
    // data, not by waiting out a real 45s timer.
    request.setTimeout?.(STALL_TIMEOUT_MS, () => {
      request.destroy(new Error(`stalled_no_data_for_${STALL_TIMEOUT_MS}ms`));
    });
    onRequest?.(request);
    request.on('error', (err) => onResponse(null, err));
  }

  async function downloadModel({ onProgress } = {}) {
    await fsPromises.mkdir(modelsDir, { recursive: true });

    // Own object per call (not just a boolean) so cancelDownload() can
    // reach the live request/write-stream even across the redirect-retry
    // recursion in httpGetFollowingRedirects above.
    const state = { cancelled: false, deletePartial: false, request: null, out: null };
    activeDownload = state;

    try {
      await new Promise((resolve, reject) => {
        const existingBytes = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
        const headers = existingBytes ? { Range: `bytes=${existingBytes}-` } : {};

        httpGetFollowingRedirects(spec.url, (res, err) => {
          if (state.cancelled) { reject(makeCancelError(state.deletePartial)); return; }
          if (err) { reject(err); return; }
          if (![200, 206].includes(res.statusCode)) {
            reject(new Error(`Model indirilemedi (HTTP ${res.statusCode})`));
            return;
          }
          // A compliant server answers a resumed request with 206. If it
          // ignores Range and returns 200, restart safely instead of appending
          // a second full model to the partial file.
          const resumeAccepted = existingBytes > 0 && res.statusCode === 206;
          const offset = resumeAccepted ? existingBytes : 0;
          const out = fs.createWriteStream(tmpPath, { flags: resumeAccepted ? 'a' : 'w' });
          state.out = out;
          out.on('error', reject);
          let received = offset;
          const total = offset + (Number(res.headers['content-length']) || (spec.sizeBytes - offset) || 0);
          onProgress?.({ received, total });
          res.on('data', (chunk) => {
            received += chunk.length;
            onProgress?.({ received, total });
          });
          res.pipe(out);
          out.on('finish', resolve);
          res.on('error', (streamErr) => reject(state.cancelled ? makeCancelError(state.deletePartial) : streamErr));
        }, 5, headers, (request) => {
          state.request = request;
          // cancelDownload() may already have fired before the request
          // object exists (a call landing between the IPC round-trip and
          // this callback) -- destroy it immediately rather than letting a
          // stray request keep running unobserved.
          if (state.cancelled) request.destroy();
        });
      });
    } catch (err) {
      // Preserve partial bytes after an ordinary network/server failure --
      // the file has the explicit .download suffix and is never considered
      // installed, so the next attempt resumes it with HTTP Range. A
      // deliberate cancel additionally deletes it when the caller asked
      // for that ("İptal", as opposed to "Durdur").
      if (state.cancelled && state.deletePartial) {
        await fsPromises.rm(tmpPath, { force: true });
      }
      throw err;
    } finally {
      activeDownload = null;
    }

    const check = await verifyChecksum(tmpPath);
    if (!check.ok) {
      await fsPromises.rm(tmpPath, { force: true });
      throw new Error(`Model bütünlük kontrolü başarısız (checksum uyuşmadı): beklenen ${check.expected}, alınan ${check.actual}`);
    }

    await fsPromises.rename(tmpPath, modelPath);
    return { ok: true, path: modelPath, sha256: check.actual };
  }

  async function removeModel() {
    // This manager's own current-tier file first -- always correct
    // regardless of what spec was passed in (a pinned tier, or, in tests,
    // an arbitrary fixture spec that MODEL_TIERS below knows nothing
    // about).
    await fsPromises.rm(modelPath, { force: true });
    await fsPromises.rm(tmpPath, { force: true });
    // Then every OTHER pinned tier's file too: Settings > Local AI's tier
    // picker (registry.js's setModelTier) repoints modelManager at a
    // different pinned model without ever touching whatever was already on
    // disk for the previously-selected tier, so a switched-away-from
    // tier's file has nothing left pointing at its path to clean it up --
    // it would otherwise sit there wasting disk space (observed firsthand:
    // ~3.9 GB of orphaned tier files, some from tiers no longer even
    // offered) forever, surviving every future "Kaldır" click since each
    // one only ever knew about the one tier active at click time. "Kaldır"
    // removing only the current tier while other real, multi-GB model
    // files sit untouched right next to it isn't what a user means by
    // "remove the model".
    for (const tierSpec of Object.values(MODEL_TIERS)) {
      const tierPath = path.join(modelsDir, tierSpec.filename);
      await fsPromises.rm(tierPath, { force: true });
      await fsPromises.rm(`${tierPath}.download`, { force: true });
    }
    return { ok: true };
  }

  function checkCapability() {
    return checkDeviceCapability(spec, { osModule: os, modelsDir });
  }

  // Combines "is the file actually there" with "can this device safely run
  // it" -- registry.js's local-llm provider gates isAvailable() on this,
  // so a device with a downloaded-but-oversized model, or a capable device
  // with no model yet, both correctly fall through to offline-extractive
  // instead of attempting to load. Synchronous to match every other
  // provider's isAvailable() contract in registry.js.
  function isAvailable() {
    if (!isModelInstalled()) return false;
    return checkCapability().capable;
  }

  return {
    spec,
    modelPath,
    isModelInstalled,
    getPartialBytes,
    verifyChecksum,
    downloadModel,
    cancelDownload,
    removeModel,
    checkCapability,
    isAvailable,
  };
}
