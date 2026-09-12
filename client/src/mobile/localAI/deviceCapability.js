// Android hardware-capability gate for the local LLM. There is no
// equivalent of Node's os.totalmem()/statfs() inside a Capacitor WebView --
// real figures require either a native Capacitor plugin call or the
// (non-standard, Chromium-only) `navigator.deviceMemory` API, which only
// reports a coarse bucketed value (0.25-8, capped at 8 regardless of
// actual RAM) and no disk/CPU info at all. `deviceInfo` is therefore
// injected by the caller -- production wiring (registry.js's
// refreshInstalledState, via llmRuntime.js's getNativeDeviceInfo()) reads
// exact values from the native LocalLLM plugin's getDeviceInfo() and
// passes them in through this same shape.
//
// Mirrors desktop/localAI/deviceCapability.js's evaluateCapability() shape
// so both platforms' local-llm providers consume the same result contract.
export const ANDROID_MIN_RAM_BYTES = 6 * 1024 * 1024 * 1024; // 6 GB total
export const ANDROID_MIN_FREE_DISK_BYTES = 2.5 * 1024 * 1024 * 1024;
export const ANDROID_RECOMMENDED_TIER = 'high'; // see checkDeviceCapability's tier note

export function evaluateCapability({ totalMemBytes, freeDiskBytes, deviceMemoryHint }, spec = {}) {
  const minRam = spec.recommendedMinRamBytes ?? ANDROID_MIN_RAM_BYTES;
  const minDisk = spec.recommendedMinFreeDiskBytes ?? ANDROID_MIN_FREE_DISK_BYTES;

  const reasons = [];
  const knownRam = typeof totalMemBytes === 'number' ? totalMemBytes : (deviceMemoryHint ?? 0) * 1024 * 1024 * 1024;

  if (!knownRam || knownRam < minRam) {
    reasons.push(`insufficient_ram:${knownRam || 'unknown'}<${minRam}`);
  }
  if (typeof freeDiskBytes === 'number' && freeDiskBytes < minDisk) {
    reasons.push(`insufficient_disk:${freeDiskBytes}<${minDisk}`);
  }
  // No RAM signal at all (neither a native plugin value nor
  // navigator.deviceMemory) is treated as NOT capable, never as capable --
  // failing safe into offline-extractive per spec point 10, rather than
  // risking an OOM kill on a device we know nothing about.
  if (!totalMemBytes && !deviceMemoryHint) {
    reasons.push('no_ram_signal');
  }

  return { capable: reasons.length === 0, reasons, totalMemBytes, freeDiskBytes, deviceMemoryHint };
}

// `nav` is injected (defaults to the real global `navigator`) so tests
// don't depend on jsdom's navigator shape. `nativeDeviceInfo` is an
// optional richer reading from a native Capacitor plugin (e.g. Capacitor's
// own @capacitor/device gives totalMemory on Android) -- passed through
// untouched when present, since it's more accurate than the
// navigator.deviceMemory bucket.
export function checkDeviceCapability(spec, { nav = (typeof navigator !== 'undefined' ? navigator : undefined), nativeDeviceInfo, freeDiskBytes } = {}) {
  const deviceMemoryHint = nav?.deviceMemory; // GB bucket, Chromium-only, capped at 8
  const totalMemBytes = nativeDeviceInfo?.totalMemBytes;
  return evaluateCapability(
    { totalMemBytes, freeDiskBytes: freeDiskBytes ?? nativeDeviceInfo?.freeDiskBytes, deviceMemoryHint },
    spec
  );
}
