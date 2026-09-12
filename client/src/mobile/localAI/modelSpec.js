// Pinned local-LLM models for Android, tiered by device RAM. The MID tier
// is the exact same model desktop/localAI/modelSpec.js pins (Qwen2.5-1.5B-
// Instruct, Q4_K_M) -- Android does not contradict the desktop model
// choice, it brackets it with a smaller LOW tier for weaker phones and a
// larger HIGH tier for phones that can comfortably afford it, per the task
// spec's "low-end -> 0.5-1.5B, mid/good -> 1.5-3B, high-end -> larger,
// optional" tiering.
//
// All three sha256/sizeBytes values below were read the same way the
// existing MID entry was (each file's HTTP redirect chain to Hugging
// Face's CDN exposes X-Linked-ETag, which for an LFS/Xet-backed file is
// its SHA-256; X-Linked-Size is the exact byte count) -- verified via a
// real HTTPS HEAD-style request on 2026-08-20, not invented. Still:
// re-verify against the actual shipped file before release (a repo's
// default `main` file can move).
const LOW = Object.freeze({
  id: 'qwen2.5-0.5b-instruct-q4_k_m',
  tier: 'low',
  label: 'Qwen2.5-0.5B-Instruct (Q4_K_M, GGUF)',
  displayLabel: 'Q LOCAL Qwen2.5 0.5B Model',
  filename: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
  url: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf',
  sha256: '74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db',
  sizeBytes: 491400032,
  license: 'Apache-2.0',
  contextSize: 1536,
  // Floor of the "capable" range for this tier -- below this, no tier is
  // offered at all (see selectTierForDevice) and the app fails safe into
  // offline-extractive rather than risking an OOM kill.
  recommendedMinRamBytes: 3 * 1024 * 1024 * 1024,
  recommendedMinFreeDiskBytes: 1 * 1024 * 1024 * 1024,
});

// Unchanged from the original single-tier pin -- same id/filename/url/
// checksum/context size as before this task, and the same model desktop
// uses. Mid-range/good Android phones (6-8 GB RAM) land here.
const MID = Object.freeze({
  id: 'qwen2.5-1.5b-instruct-q4_k_m',
  tier: 'mid',
  label: 'Qwen2.5-1.5B-Instruct (Q4_K_M, GGUF)',
  displayLabel: 'Q LOCAL Qwen2.5 1.5B Model',
  filename: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
  url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf',
  sha256: '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e',
  sizeBytes: 1117320736,
  license: 'Apache-2.0',
  contextSize: 2048,
  recommendedMinRamBytes: 6 * 1024 * 1024 * 1024,
  recommendedMinFreeDiskBytes: 2.5 * 1024 * 1024 * 1024,
});

// High-end tier -- optional per the task spec ("a larger model, optional").
// Upgraded from 3B to 7B at the owner's explicit request for a "very
// powerful" device. Qwen's own GGUF repo only ships this quant as a
// 2-shard split file (qwen2.5-7b-instruct-q4_k_m-0000{1,2}-of-00002.gguf),
// which llama_model_load_from_file() (a single-path API -- see
// llama-android.cpp's nativeLoad) can't load directly; bartowski's
// community requant (same Apache-2.0 source model, same Q4_K_M quant
// method) ships the identical model as one file instead, so that's what's
// pinned here. sha256/sizeBytes read the same way every other entry in
// this file was (X-Linked-ETag/X-Linked-Size on the HF CDN redirect),
// verified via a real HTTPS HEAD request on 2026-08-24 -- re-verify before
// release, same caveat as the other tiers.
const HIGH = Object.freeze({
  id: 'qwen2.5-7b-instruct-q4_k_m',
  tier: 'high',
  label: 'Qwen2.5-7B-Instruct (Q4_K_M, GGUF)',
  displayLabel: 'Q LOCAL Qwen2.5 7B Model',
  filename: 'qwen2.5-7b-instruct-q4_k_m.gguf',
  url: 'https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf',
  sha256: '65b8fcd92af6b4fefa935c625d1ac27ea29dcb6ee14589c55a8f115ceaaa1423',
  sizeBytes: 4683074240,
  license: 'Apache-2.0',
  contextSize: 2048,
  // A 4.68GB model file alone needs real headroom above the MID tier's
  // floor -- 12GB matches the actual device this was validated against
  // (see selectTierForDevice's comment) rather than a lower, untested
  // number.
  recommendedMinRamBytes: 12 * 1024 * 1024 * 1024,
  recommendedMinFreeDiskBytes: 6 * 1024 * 1024 * 1024,
});

// Second model family, offered alongside (not instead of) the Qwen2.5
// tiers above -- a manual-only pick from Settings > Local AI's tier
// picker, never returned by selectTierForDevice() below, so it changes
// nothing about the existing automatic RAM-based selection or about any
// device that never opens the picker. Mirrors desktop/localAI/
// modelSpec.js's own PHI_MINI -- see that file's comment for why
// bartowski's requant is pinned instead of Microsoft's own (gated, 401
// without a HF login) GGUF repo, and for the license/checksum sourcing.
// No phi-14b tier here (unlike desktop): its 9GB file is roughly double
// every other tier below and is what actually triggered the OOM-kill
// crash history described in HIGH's own comment above -- not offered on
// this platform at all, regardless of RAM floor. MISTRAL_7B/GRANITE_8B/
// GEMMA_9B further below are a different call: comparable to or only
// modestly above HIGH's own already-shipped 4.68GB file, offered at the
// owner's explicit request despite carrying the same category of risk as
// any large on-device model on Android.
const PHI_MINI = Object.freeze({
  id: 'phi-4-mini-instruct-q4_k_m',
  tier: 'phi-mini',
  label: 'Phi-4-mini-instruct (Q4_K_M, GGUF)',
  displayLabel: 'Q LOCAL Phi-4 Mini Model',
  filename: 'phi-4-mini-instruct-q4_k_m.gguf',
  url: 'https://huggingface.co/bartowski/microsoft_Phi-4-mini-instruct-GGUF/resolve/main/microsoft_Phi-4-mini-instruct-Q4_K_M.gguf',
  sha256: '01999f17c39cc3074afae5e9c539bc82d45f2dd7faa3917c66cbef76fce8c0c2',
  sizeBytes: 2491874688,
  license: 'MIT',
  contextSize: 2048,
  // Between MID's and HIGH's own floors above, in the same proportion to
  // this file's size (2.49GB, between MID's 1.04GB and HIGH's 4.68GB).
  recommendedMinRamBytes: 8 * 1024 * 1024 * 1024,
  recommendedMinFreeDiskBytes: 4 * 1024 * 1024 * 1024,
});

// Further manual-only families, same spirit as PHI_MINI above -- mirrors
// desktop/localAI/modelSpec.js's own LLAMA_1B/LLAMA_3B/GRANITE_2B/GEMMA_2B
// (see that file's comment for checksum sourcing and the Llama/Gemma
// license notes).
const LLAMA_1B = Object.freeze({
  id: 'llama-3.2-1b-instruct-q4_k_m',
  tier: 'llama-1b',
  label: 'Llama-3.2-1B-Instruct (Q4_K_M, GGUF)',
  displayLabel: 'Q LOCAL Llama 3.2 1B Model',
  filename: 'llama-3.2-1b-instruct-q4_k_m.gguf',
  url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf',
  sha256: '6f85a640a97cf2bf5b8e764087b1e83da0fdb51d7c9fab7d0fece9385611df83',
  sizeBytes: 807694464,
  license: 'Llama 3.2 Community License',
  contextSize: 2048,
  recommendedMinRamBytes: 3 * 1024 * 1024 * 1024,
  recommendedMinFreeDiskBytes: 1.5 * 1024 * 1024 * 1024,
});

const LLAMA_3B = Object.freeze({
  id: 'llama-3.2-3b-instruct-q4_k_m',
  tier: 'llama-3b',
  label: 'Llama-3.2-3B-Instruct (Q4_K_M, GGUF)',
  displayLabel: 'Q LOCAL Llama 3.2 3B Model',
  filename: 'llama-3.2-3b-instruct-q4_k_m.gguf',
  url: 'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
  sha256: '6c1a2b41161032677be168d354123594c0e6e67d2b9227c84f296ad037c728ff',
  sizeBytes: 2019377696,
  license: 'Llama 3.2 Community License',
  contextSize: 2048,
  recommendedMinRamBytes: 5 * 1024 * 1024 * 1024,
  recommendedMinFreeDiskBytes: 3 * 1024 * 1024 * 1024,
});

const GRANITE_2B = Object.freeze({
  id: 'granite-3.1-2b-instruct-q4_k_m',
  tier: 'granite-2b',
  label: 'Granite-3.1-2B-Instruct (Q4_K_M, GGUF)',
  displayLabel: 'Q LOCAL Granite 3.1 2B Model',
  filename: 'granite-3.1-2b-instruct-q4_k_m.gguf',
  url: 'https://huggingface.co/bartowski/granite-3.1-2b-instruct-GGUF/resolve/main/granite-3.1-2b-instruct-Q4_K_M.gguf',
  sha256: '774269c82fde2720ea18dcf457fb5bd028fe096139a0735f4ad59c0a270cfc9c',
  sizeBytes: 1545295424,
  license: 'Apache-2.0',
  contextSize: 2048,
  recommendedMinRamBytes: 6 * 1024 * 1024 * 1024,
  recommendedMinFreeDiskBytes: 2.5 * 1024 * 1024 * 1024,
});

const GEMMA_2B = Object.freeze({
  id: 'gemma-2-2b-it-q4_k_m',
  tier: 'gemma-2b',
  label: 'Gemma-2-2B-it (Q4_K_M, GGUF)',
  displayLabel: 'Q LOCAL Gemma 2 2B Model',
  filename: 'gemma-2-2b-it-q4_k_m.gguf',
  url: 'https://huggingface.co/bartowski/gemma-2-2b-it-GGUF/resolve/main/gemma-2-2b-it-Q4_K_M.gguf',
  sha256: 'e0aee85060f168f0f2d8473d7ea41ce2f3230c1bc1374847505ea599288a7787',
  sizeBytes: 1708582752,
  license: 'Gemma Terms of Use',
  contextSize: 2048,
  recommendedMinRamBytes: 6 * 1024 * 1024 * 1024,
  recommendedMinFreeDiskBytes: 2.5 * 1024 * 1024 * 1024,
});

// Larger siblings of the families above -- offered here at the owner's
// explicit request despite each carrying the same category of on-device
// risk as any large model on Android (see the comment above PHI_MINI).
// Same specs/checksums as desktop/localAI/modelSpec.js's own
// MISTRAL_7B/GRANITE_8B/GEMMA_9B, just with this platform's smaller
// contextSize convention (2048, matching every other tier in this file).
const MISTRAL_7B = Object.freeze({
  id: 'mistral-7b-instruct-v0.3-q4_k_m',
  tier: 'mistral-7b',
  label: 'Mistral-7B-Instruct-v0.3 (Q4_K_M, GGUF)',
  displayLabel: 'Q LOCAL Mistral 7B Model',
  filename: 'mistral-7b-instruct-v0.3-q4_k_m.gguf',
  url: 'https://huggingface.co/bartowski/Mistral-7B-Instruct-v0.3-GGUF/resolve/main/Mistral-7B-Instruct-v0.3-Q4_K_M.gguf',
  sha256: '1270d22c0fbb3d092fb725d4d96c457b7b687a5f5a715abe1e818da303e562b6',
  sizeBytes: 4372812000,
  license: 'Apache-2.0',
  contextSize: 2048,
  // Same size class as HIGH's own already-shipped Qwen2.5-7B -- same floor.
  recommendedMinRamBytes: 12 * 1024 * 1024 * 1024,
  recommendedMinFreeDiskBytes: 6 * 1024 * 1024 * 1024,
});

const GRANITE_8B = Object.freeze({
  id: 'granite-3.1-8b-instruct-q4_k_m',
  tier: 'granite-8b',
  label: 'Granite-3.1-8B-Instruct (Q4_K_M, GGUF)',
  displayLabel: 'Q LOCAL Granite 3.1 8B Model',
  filename: 'granite-3.1-8b-instruct-q4_k_m.gguf',
  url: 'https://huggingface.co/bartowski/granite-3.1-8b-instruct-GGUF/resolve/main/granite-3.1-8b-instruct-Q4_K_M.gguf',
  sha256: 'b72cfca8e30f23af77f922ce18d6fe1a5d4925907dddf7249c0cabc2739d48c8',
  sizeBytes: 4942858720,
  license: 'Apache-2.0',
  contextSize: 2048,
  recommendedMinRamBytes: 13 * 1024 * 1024 * 1024,
  recommendedMinFreeDiskBytes: 6.5 * 1024 * 1024 * 1024,
});

const GEMMA_9B = Object.freeze({
  id: 'gemma-2-9b-it-q4_k_m',
  tier: 'gemma-9b',
  label: 'Gemma-2-9B-it (Q4_K_M, GGUF)',
  displayLabel: 'Q LOCAL Gemma 2 9B Model',
  filename: 'gemma-2-9b-it-q4_k_m.gguf',
  url: 'https://huggingface.co/bartowski/gemma-2-9b-it-GGUF/resolve/main/gemma-2-9b-it-Q4_K_M.gguf',
  sha256: '13b2a7b4115bbd0900162edcebe476da1ba1fc24e718e8b40d32f6e300f56dfe',
  sizeBytes: 5761057728,
  license: 'Gemma Terms of Use',
  contextSize: 2048,
  recommendedMinRamBytes: 15 * 1024 * 1024 * 1024,
  recommendedMinFreeDiskBytes: 7.5 * 1024 * 1024 * 1024,
});

export const MODEL_TIERS = Object.freeze({
  low: LOW,
  mid: MID,
  high: HIGH,
  'phi-mini': PHI_MINI,
  'llama-1b': LLAMA_1B,
  'llama-3b': LLAMA_3B,
  'mistral-7b': MISTRAL_7B,
  'granite-2b': GRANITE_2B,
  'granite-8b': GRANITE_8B,
  'gemma-2b': GEMMA_2B,
  'gemma-9b': GEMMA_9B,
});

// Backward-compatible single-spec export -- the MID tier, i.e. exactly what
// this file exported before tiering existed. modelManager.js's default
// `spec` param and any caller that hasn't opted into tiering yet keeps
// working unchanged.
export const MODEL_SPEC = MID;

// Picks the richest tier a device can realistically run, or null if the
// device doesn't clear even the LOW floor -- callers must treat null as
// "no local-llm tier available on this device" and fail safe into
// offline-extractive, same as deviceCapability.js's own no-RAM-signal
// fail-safe. `deviceInfo` is `{ totalMemBytes, freeDiskBytes }` (or
// undefined/null) -- the same native-device-info shape llmRuntime.js's
// getNativeDeviceInfo() returns from the Capacitor plugin.
//
// HIGH was disabled for a while after a real 12GB-RAM device generating
// with the 3B model got killed by Android mid-generation (a native OOM
// kill or OEM "unresponsive foreground app" kill neither JS nor the Kotlin
// plugin's try/catch can observe, since the whole process is torn down
// externally). Re-enabled at the same 8GB+ floor now that
// llama-android.cpp's generation loop has real safety nets that didn't
// exist at the time of that crash: a generous-but-real wall-clock deadline
// (so a slow/throttled device can't run unbounded into the same failure)
// and a forced minimum output length (so a HIGH-tier run that does finish
// quickly still produces a real answer, not a one-word non-answer). Still
// the least field-tested of the three tiers -- a genuinely underpowered
// "8GB RAM" device (e.g. heavy background load, thermal throttling) can
// still be slow enough to hit the deadline before finishing.
export function selectTierForDevice(deviceInfo) {
  const ram = deviceInfo?.totalMemBytes;
  if (typeof ram !== 'number' || ram <= 0) return null;
  if (ram >= HIGH.recommendedMinRamBytes) return HIGH;
  if (ram >= MID.recommendedMinRamBytes) return MID;
  if (ram >= LOW.recommendedMinRamBytes) return LOW;
  return null;
}
