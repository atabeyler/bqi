import nodeOsDefault from 'node:os';
import nodeFsDefault from 'node:fs';

// Desktop hardware-capability gate for the local LLM. Synchronous by
// design -- registry.js's isAvailable() contract (used by every existing
// provider) is synchronous, so this has to be too for the local-llm
// provider to plug into the exact same selectProvider() seam without
// changing that contract for every provider. Kept separate from
// modelManager.js so it can be unit-tested with fully injected values;
// the real os/fs calls only happen inside the exported functions below,
// never at import time (spec point 9: nothing probes the device or
// network just from importing this module).
//
// Desktop assumption: a laptop/desktop with a real disk and typically
// 8-32 GB RAM, so the bar is "don't try to run a 1.1 GB Q4 model on a
// machine with under ~4 GB RAM total" rather than anything aggressive.
export const DESKTOP_MIN_RAM_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB
export const DESKTOP_MIN_FREE_DISK_BYTES = 3 * 1024 * 1024 * 1024; // 3 GB
export const DESKTOP_MIN_CPU_CORES = 2;

// Pure function -- easy to unit test with synthetic inputs, and reused by
// checkDeviceCapability() below with real values.
export function evaluateCapability({ totalMemBytes, freeDiskBytes, cpuCount }, spec = {}) {
  const minRam = spec.recommendedMinRamBytes ?? DESKTOP_MIN_RAM_BYTES;
  const minDisk = spec.recommendedMinFreeDiskBytes ?? DESKTOP_MIN_FREE_DISK_BYTES;

  const reasons = [];
  if (typeof totalMemBytes !== 'number' || totalMemBytes < minRam) {
    reasons.push(`insufficient_ram:${totalMemBytes ?? 'unknown'}<${minRam}`);
  }
  if (typeof freeDiskBytes === 'number' && freeDiskBytes < minDisk) {
    reasons.push(`insufficient_disk:${freeDiskBytes}<${minDisk}`);
  }
  if (typeof cpuCount === 'number' && cpuCount < DESKTOP_MIN_CPU_CORES) {
    reasons.push(`insufficient_cpu:${cpuCount}<${DESKTOP_MIN_CPU_CORES}`);
  }

  return {
    capable: reasons.length === 0,
    reasons,
    totalMemBytes,
    freeDiskBytes,
    cpuCount,
  };
}

// Real-hardware version. `osModule`/`fsModule` are injected (defaulting to
// Node's real modules) purely so tests can stub them without touching the
// actual machine; production call sites never pass these two args.
export function checkDeviceCapability(spec, { osModule = nodeOsDefault, fsModule = nodeFsDefault, modelsDir } = {}) {
  const totalMemBytes = osModule.totalmem();
  const cpuCount = (osModule.cpus() || []).length;

  let freeDiskBytes;
  try {
    // fs.statfsSync is available on Node >=19.6 (Electron 33 bundles
    // Node 20.x, so this is safe there); wrapped in try/catch so an older
    // Node or an exotic filesystem just skips the disk check rather than
    // failing capability detection outright -- disk exhaustion still
    // surfaces later as an explicit download failure in modelManager.js.
    const stats = fsModule.statfsSync(modelsDir || osModule.tmpdir());
    freeDiskBytes = stats.bavail * stats.bsize;
  } catch {
    freeDiskBytes = undefined;
  }

  return evaluateCapability({ totalMemBytes, freeDiskBytes, cpuCount }, spec);
}
