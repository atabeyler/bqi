import { Filesystem, Directory } from '@capacitor/filesystem';
import { MODEL_SPEC, MODEL_TIERS } from './modelSpec.js';
import { checkDeviceCapability } from './deviceCapability.js';
import { getCapacitorPlugin } from './llmRuntime.js';

const MODELS_SUBDIR = 'bqi-models';

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK_SIZE = 0x8000; // avoid blowing the call-stack limit, same fix as mobileBridge.js's arrayBufferToBase64
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function chunkToBase64(value) {
  const view = value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
    ? value
    : value.slice();
  return bufferToBase64(view.buffer);
}

// Real Local Model Manager for Android/Capacitor: install-check, streamed
// download (fetch -> chunked writes to app-private storage via
// @capacitor/filesystem, never a single giant in-memory buffer written in
// one shot), SHA-256 checksum verification, remove, and a device-capability
// gate. No network access happens unless install()/downloadModel() is
// explicitly called by the user (spec point 9/privacy).
//
// Checksum verification prefers the native LocalLLM.sha256File method, so
// resumed downloads can be verified from disk without reloading the whole
// model into the WebView. Tests/non-native shells still use WebCrypto as a
// fallback for small fixtures.
export function createModelManager({ spec = MODEL_SPEC, fetchImpl = fetch, subtleCrypto = (typeof crypto !== 'undefined' ? crypto.subtle : undefined), filesystem = Filesystem, directory = Directory.Data, deviceInfo, nativeFileHash } = {}) {
  const relativePath = `${MODELS_SUBDIR}/${spec.filename}`;
  const tmpRelativePath = `${relativePath}.download`;

  async function isModelInstalled() {
    try {
      await filesystem.stat({ path: relativePath, directory });
      return true;
    } catch {
      return false;
    }
  }

  async function getPartialBytes() {
    try {
      const stat = await filesystem.stat({ path: tmpRelativePath, directory });
      return Number(stat.size) || 0;
    } catch {
      return 0;
    }
  }

  function getNativeFileHasher() {
    return nativeFileHash || getCapacitorPlugin('LocalLLM')?.sha256File;
  }

  async function hashInstalledFile(path) {
    const hasher = getNativeFileHasher();
    if (hasher) {
      const result = await hasher({ modelPath: path });
      if (result?.sha256) return result.sha256;
    }
    return null;
  }

  // Tracks the single in-flight downloadModel() call, if any, so
  // cancelDownload() (Settings > Local AI's "Durdur"/"İptal" buttons) can
  // reach it. Only one download runs at a time -- the panel disables its
  // Download button while downloading is true.
  let activeDownload = null;

  function makeCancelError(deletePartial) {
    const err = new Error('İndirme durduruldu.');
    err.cancelled = true;
    err.deletePartial = deletePartial;
    return err;
  }

  // deletePartial: false pauses (keeps the .download file on disk for the
  // next Range-resumed attempt, i.e. "Devam Et"); true also deletes it (a
  // full "İptal" back to a clean not-installed state).
  async function cancelDownload({ deletePartial = false } = {}) {
    if (activeDownload) {
      activeDownload.cancelled = true;
      activeDownload.deletePartial = deletePartial;
      activeDownload.controller.abort();
      return { ok: true };
    }
    // Nothing in flight -- e.g. "İptal Et" clicked on an already-paused
    // ("Devam Et") download. There's no request to interrupt, but a
    // deletePartial request should still discard the leftover .download
    // file so the user can actually walk away from it instead of being
    // forced to resume first just so there's something to cancel.
    if (deletePartial) {
      await filesystem.deleteFile({ path: tmpRelativePath, directory }).catch(() => {}); // already gone -- same end state
      return { ok: true };
    }
    return { ok: false, error: 'no_active_download' };
  }

  async function downloadModel({ onProgress } = {}) {
    await filesystem.mkdir({ path: MODELS_SUBDIR, directory, recursive: true }).catch(() => {});

    const state = { cancelled: false, deletePartial: false, controller: new AbortController() };
    activeDownload = state;

    // Mirrors desktop/localAI/modelManager.js's stall guard: a connection
    // that goes quiet mid-transfer without actually closing (server/CDN
    // hiccup, a dropped network hop) previously hung this fetch/reader loop
    // forever -- no error, no progress, indefinitely, since neither fetch()
    // nor reader.read() have any built-in inactivity timeout. Re-armed
    // before the initial fetch and after every chunk, so a slow-but-still-
    // flowing download is never affected -- only one that's gone genuinely
    // silent for STALL_TIMEOUT_MS. Aborting the shared controller is what
    // actually unsticks a hung reader.read()/fetch() call; stalled tracks
    // that this abort was OUR watchdog and not a user-initiated
    // cancelDownload(), so the catch block below can tell them apart and
    // still surface a clear stalled_no_data_for_*ms message instead of a
    // generic AbortError.
    const STALL_TIMEOUT_MS = 45_000;
    let stallTimer;
    let stalled = false;
    const armStallTimer = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        state.controller.abort();
      }, STALL_TIMEOUT_MS);
    };
    const disarmStallTimer = () => clearTimeout(stallTimer);

    try {
      armStallTimer();
      const hasNativeHasher = !!getNativeFileHasher();
      const existingBytes = hasNativeHasher ? await getPartialBytes() : 0;
      const headers = existingBytes ? { Range: `bytes=${existingBytes}-` } : undefined;
      const res = await fetchImpl(spec.url, { redirect: 'follow', signal: state.controller.signal, ...(headers ? { headers } : {}) });
      if (!res.ok) throw new Error(`Model indirilemedi (HTTP ${res.status})`);

      const resumeAccepted = existingBytes > 0 && res.status === 206;
      const offset = resumeAccepted ? existingBytes : 0;
      const total = offset + (Number(res.headers.get('content-length')) || (spec.sizeBytes - offset) || 0);
      const reader = res.body?.getReader?.();
      const chunks = [];
      let received = offset;

      if (!resumeAccepted) await filesystem.writeFile({ path: tmpRelativePath, directory, data: '' }).catch(() => {});
      onProgress?.({ received, total });

      if (reader) {
        // Real chunked download: each chunk is appended to disk as it
        // arrives (never holding the whole file as one write call), while
        // also kept for the final in-memory checksum (see the module-level
        // comment on why that part isn't chunked too).
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          armStallTimer(); // a chunk just arrived -- the connection is alive, push the deadline back out
          if (!hasNativeHasher) chunks.push(value);
          received += value.length;
          await filesystem.appendFile({ path: tmpRelativePath, directory, data: chunkToBase64(value) });
          onProgress?.({ received, total });
        }
      } else {
        // Fallback for a fetch polyfill without a streaming body reader --
        // still a real network download, just not incrementally written.
        const buf = await res.arrayBuffer();
        if (!hasNativeHasher) chunks.push(new Uint8Array(buf));
        received = offset + buf.byteLength;
        await filesystem.appendFile({ path: tmpRelativePath, directory, data: bufferToBase64(buf) });
        onProgress?.({ received, total });
      }

      let actual = await hashInstalledFile(tmpRelativePath);
      if (!actual) {
        if (resumeAccepted) {
          await filesystem.deleteFile({ path: tmpRelativePath, directory }).catch(() => {});
          throw new Error('native_file_hash_unavailable_after_resume');
        }
        const full = new Uint8Array(received);
        let writeOffset = resumeAccepted ? existingBytes : 0;
        for (const chunk of chunks) { full.set(chunk, writeOffset); writeOffset += chunk.length; }
        if (!subtleCrypto) throw new Error('web_crypto_unavailable');
        const digest = await subtleCrypto.digest('SHA-256', full.buffer);
        actual = bufferToHex(digest);
      }

      if (actual !== spec.sha256) {
        await filesystem.deleteFile({ path: tmpRelativePath, directory }).catch(() => {});
        throw new Error(`Model bütünlük kontrolü başarısız: beklenen ${spec.sha256}, alınan ${actual}`);
      }

      await filesystem.rename({ from: tmpRelativePath, to: relativePath, directory, toDirectory: directory });
      return { ok: true, sha256: actual };
    } catch (err) {
      // A deliberate cancel ("Durdur"/"İptal") surfaces as fetch/reader
      // throwing an AbortError -- report it as a cancellation instead of a
      // real download failure, and only delete the partial file when the
      // caller asked for that ("İptal", as opposed to pausing with
      // "Durdur", which keeps it for the next Range-resumed attempt).
      if (state.cancelled) {
        if (state.deletePartial) await filesystem.deleteFile({ path: tmpRelativePath, directory }).catch(() => {});
        throw makeCancelError(state.deletePartial);
      }
      // The stall watchdog also aborts state.controller to unstick a hung
      // reader.read()/fetch() call, which otherwise surfaces here as the
      // exact same generic AbortError a user-initiated cancel produces --
      // `stalled` is what tells the two apart, so this path keeps the
      // partial file (same as any other network failure, resumable via
      // Range on the next attempt) and reports a message that actually
      // says what happened instead of a bare "Aborted".
      if (stalled) throw new Error(`stalled_no_data_for_${STALL_TIMEOUT_MS}ms`, { cause: err });
      throw err;
    } finally {
      disarmStallTimer();
      activeDownload = null;
    }
  }

  async function removeModel() {
    // This manager's own current-tier file (and its own leftover partial
    // download, if any) first -- always correct regardless of what spec
    // was passed in.
    await filesystem.deleteFile({ path: relativePath, directory }).catch(() => {});
    await filesystem.deleteFile({ path: tmpRelativePath, directory }).catch(() => {});
    // Then every OTHER pinned tier's file too: mirrors desktop/localAI/
    // modelManager.js's removeModel fix -- see that module's comment for
    // the orphaned-file incident this addresses. Switching tiers via the
    // Settings > Local AI picker only repoints modelManager at a different
    // pinned model, it never touches whatever was already on disk for the
    // previously-selected tier.
    for (const tierSpec of Object.values(MODEL_TIERS)) {
      const tierRelativePath = `${MODELS_SUBDIR}/${tierSpec.filename}`;
      await filesystem.deleteFile({ path: tierRelativePath, directory }).catch(() => {});
      await filesystem.deleteFile({ path: `${tierRelativePath}.download`, directory }).catch(() => {});
    }
    return { ok: true };
  }

  function checkCapability() {
    return checkDeviceCapability(spec, deviceInfo);
  }

  // Synchronous where it can be (matches every provider's isAvailable()
  // contract in registry.js) -- relies on `installed` being tracked by the
  // caller (registry.js refreshes it) since Filesystem.stat() is async and
  // there is no sync file-existence check available in a WebView.
  function isAvailableSync(installed) {
    return !!installed && checkCapability().capable;
  }

  return {
    spec,
    // Exposed so llmProvider.js can hand the native LocalLLM plugin a real,
    // resolvable-on-disk path (this module's own MODELS_SUBDIR + filename)
    // instead of just spec.filename -- a bare filename has no directory
    // component and the native side would otherwise have to duplicate
    // MODELS_SUBDIR as a second source of truth. The native plugin resolves
    // this relative path against the app's private files dir (Android's
    // equivalent of @capacitor/filesystem's Directory.Data -- see
    // LocalLLMPlugin.kt's comment on that mapping).
    relativePath,
    isModelInstalled,
    getPartialBytes,
    downloadModel,
    cancelDownload,
    removeModel,
    checkCapability,
    isAvailableSync,
  };
}
