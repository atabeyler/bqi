/**
 * Bounds how many of this route's uploads are held in memory at once.
 *
 * The /analysis/upload route buffers the whole file in RAM (multer
 * memoryStorage) to hand it straight to a parser (pdf-parse, mammoth, the
 * XLSX/CSV readers) and never persists it -- rewriting every one of those
 * parsers to stream would be a much larger change for a bug that's really
 * about worst-case RAM under concurrent load, not about any single parser.
 * A per-user rate limit (see analysisLimiter) doesn't help here: many
 * different users each uploading a 20MB file at the same moment is exactly
 * the case that limiter doesn't catch. This middleware rejects outright
 * once too many uploads are in flight at once, the same
 * count-slots-then-release pattern quantumProcess.js uses for the Python
 * worker pool, just rejecting instead of queueing (an upload should be
 * quick; queueing it would just trade a fast, clear 503 for a slow, opaque
 * timeout on the client).
 */
const MAX_CONCURRENT_UPLOADS = Number(process.env.UPLOAD_MAX_CONCURRENCY) || 8;
let activeUploads = 0;

export function uploadConcurrencyGate(req, res, next) {
  if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
    return res.status(503).json({ error: 'Sunucu şu anda çok fazla dosya işliyor, lütfen birazdan tekrar deneyin.' });
  }
  activeUploads += 1;
  const release = () => { activeUploads = Math.max(0, activeUploads - 1); };
  res.once('finish', release);
  res.once('close', release);
  next();
}

export function getUploadConcurrencyStatus() {
  return { active: activeUploads, maxConcurrency: MAX_CONCURRENT_UPLOADS };
}
