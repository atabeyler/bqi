// Pinned local-LLM models, tiered by device RAM. Mirrors
// client/src/mobile/localAI/modelSpec.js's tiering shape (duplicated, same
// as the rest of the desktop/* vs client/src/mobile/* split in this
// codebase, so each platform can vary its pinned quants independently).
//
// MID is the original single pinned model this file exported before
// tiering existed -- same id/filename/sha256/contextSize, unchanged, so an
// already-downloaded model on an existing desktop install still matches.
//
//   - License: Apache-2.0 (verified on the model card at
//     https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF on 2026-08-20)
//     -- permissive, no separate commercial license needed, unlike the
//     Qwen license that applies to the 3B/7B+ Qwen2.5 checkpoints.
//   - Turkish: Qwen2.5's tokenizer/training corpus is explicitly
//     multilingual (29+ languages including Turkish per the Qwen2.5
//     technical report); no formal Turkish-quality eval harness has been
//     run against it, only real-device manual verification.
//   - Size: ~1.07 GB (Q4_K_M), comfortably inside a 4-8 GB RAM desktop
//     budget alongside the rest of the Electron app.
//   - Runtime: node-llama-cpp (MIT), which ships prebuilt llama.cpp
//     bindings for Windows/macOS/Linux -- see llmRuntime.js.
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
  recommendedMinRamBytes: 3 * 1024 * 1024 * 1024,
  recommendedMinFreeDiskBytes: 1 * 1024 * 1024 * 1024,
});

const MID = Object.freeze({
  id: 'qwen2.5-1.5b-instruct-q4_k_m',
  tier: 'mid',
  label: 'Qwen2.5-1.5B-Instruct (Q4_K_M, GGUF)',
  displayLabel: 'Q LOCAL Qwen2.5 1.5B Model',
  filename: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
  // Hugging Face resolve URL for the pinned file/revision. Points at
  // `main` (not a pinned commit) intentionally -- Qwen's GGUF repo does
  // not retag revisions for this file, and the checksum below is what
  // actually guards integrity, not the URL.
  url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf',
  // SHA-256 read from the file's HF LFS ETag (X-Linked-ETag header on the
  // resolve redirect) on 2026-08-20 -- HF serves SHA-256-tracked LFS
  // objects with their content hash as the ETag, so this is the real
  // published checksum, not a placeholder.
  sha256: '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e',
  sizeBytes: 1117320736,
  license: 'Apache-2.0',
  contextSize: 4096,
  // Conservative device gate: llama.cpp needs roughly (model size) +
  // (KV cache for contextSize) + OS/app headroom resident. ~2x the file
  // size is a common rule of thumb for Q4 GGUF at a few-thousand-token
  // context; desktop and mobile apply this to different minimums (see
  // desktop/localAI/deviceCapability.js and
  // client/src/mobile/localAI/deviceCapability.js).
  recommendedMinRamBytes: 4 * 1024 * 1024 * 1024,
  recommendedMinFreeDiskBytes: 3 * 1024 * 1024 * 1024, // model + temp download + headroom
});

// Optional high-end tier for a genuinely capable desktop/laptop -- added
// at the owner's request, mirroring client/src/mobile/localAI/modelSpec.js's
// own HIGH tier (same 7B model, same reasoning for why it's bartowski's
// single-file requant rather than Qwen's own 2-shard split GGUF -- see
// that file's comment). Desktop's own risk profile is milder than a
// phone's (no OS foreground-app watchdog to kill the whole process, no
// battery/thermal constraint on the same scale), but a real download-size
// and RAM floor still apply.
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
  contextSize: 4096,
  recommendedMinRamBytes: 12 * 1024 * 1024 * 1024,
  recommendedMinFreeDiskBytes: 6 * 1024 * 1024 * 1024,
});

// Second model family, offered alongside (not instead of) the Qwen2.5
// tiers above -- a manual-only pick from Settings > Local AI's tier
// picker, never returned by selectTierForDevice() below, so it changes
// nothing about the existing automatic RAM-based selection or about any
// device that never opens the picker.
//
//   - Publisher: Microsoft (Phi-4 family) -- MIT license, verified on the
//     model's Hugging Face card (huggingface.co/microsoft/Phi-4-mini-
//     instruct and huggingface.co/microsoft/phi-4) on 2026-08-27.
//   - GGUF source: Microsoft's own official GGUF repos
//     (microsoft/Phi-4-mini-instruct-gguf, microsoft/phi-4-gguf) require a
//     Hugging Face account + accepted license click-through to download
//     (confirmed: an unauthenticated request gets HTTP 401) -- unusable
//     for this app's anonymous HTTPS download. bartowski's community
//     requant (same MIT-licensed weights, same Q4_K_M quant method, no
//     gating) is pinned instead, same reasoning as HIGH's Qwen2.5-7B
//     pick above.
//   - sha256/sizeBytes read the same way every other entry in this file
//     was (X-Linked-ETag/X-Linked-Size on the HF CDN redirect), verified
//     via a real HTTPS HEAD request on 2026-08-27 -- re-verify before
//     release, same caveat as the other tiers.
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
  contextSize: 4096,
  recommendedMinRamBytes: 8 * 1024 * 1024 * 1024,
  recommendedMinFreeDiskBytes: 4 * 1024 * 1024 * 1024,
});

// Full-size Phi-4 (14B) -- meaningfully higher quality than any Qwen2.5
// tier above (per public MMLU benchmarks) at the cost of a much higher
// RAM floor. Desktop-only (see client/src/mobile/localAI/modelSpec.js --
// mobile does not pin this): a phone-class device faces real OOM-kill
// risk at this size (see that file's own HIGH-tier comment for the actual
// crash history), a desktop/laptop with the RAM to spare does not.
const PHI_14B = Object.freeze({
  id: 'phi-4-q4_k_m',
  tier: 'phi-14b',
  label: 'Phi-4 (Q4_K_M, GGUF)',
  displayLabel: 'Q LOCAL Phi-4 Model',
  filename: 'phi-4-q4_k_m.gguf',
  url: 'https://huggingface.co/bartowski/phi-4-GGUF/resolve/main/phi-4-Q4_K_M.gguf',
  sha256: '009aba717c09d4a35890c7d35eb59d54e1dba884c7c526e7197d9c13ab5911d9',
  sizeBytes: 9053114816,
  license: 'MIT',
  contextSize: 4096,
  // A ~9GB Q4 file run on CPU (no dedicated GPU/VRAM pool -- see
  // llmRuntime.js) needs real headroom above HIGH's own 12GB floor for a
  // file half this size; conservative on purpose, same philosophy as
  // every other floor in this file.
  recommendedMinRamBytes: 20 * 1024 * 1024 * 1024,
  recommendedMinFreeDiskBytes: 12 * 1024 * 1024 * 1024,
});

// Further manual-only families, same spirit as PHI_MINI/PHI_14B above:
// never returned by selectTierForDevice(), pure user choice from Settings >
// Local AI's tier picker. sha256/sizeBytes for every entry below were read
// directly from each Hugging Face repo's tree API
// (huggingface.co/api/models/{repo}/tree/main, which reports each LFS
// file's real oid/size -- the same content hash HF itself serves, not a
// placeholder) on 2026-08-28; license field read from the *original*
// (non-quantized) source repo's own cardData.license on the same date,
// since a GGUF requant repo doesn't reliably restate it. Re-verify both
// before release, same standing caveat as every other tier in this file.
//
//   - Llama 3.2 (Meta): NOT Apache/MIT -- the Llama 3.2 Community License
//     is a custom, non-OSI license with real usage terms (an acceptable-use
//     policy, and a requirement that any product/service with >700M MAU as
//     of the app's release date obtain a separate license from Meta). Fine
//     for this deployment's scale, but distinct enough from every other
//     tier's clean Apache-2.0/MIT that it's worth a user's own informed
//     opt-in rather than ever being auto-selected.
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
  contextSize: 4096,
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
  contextSize: 4096,
  recommendedMinRamBytes: 5 * 1024 * 1024 * 1024,
  recommendedMinFreeDiskBytes: 3 * 1024 * 1024 * 1024,
});

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
  contextSize: 4096,
  // Same size class as HIGH's Qwen2.5-7B -- same RAM/disk floor.
  recommendedMinRamBytes: 12 * 1024 * 1024 * 1024,
  recommendedMinFreeDiskBytes: 6 * 1024 * 1024 * 1024,
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
  contextSize: 4096,
  recommendedMinRamBytes: 6 * 1024 * 1024 * 1024,
  recommendedMinFreeDiskBytes: 2.5 * 1024 * 1024 * 1024,
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
  contextSize: 4096,
  recommendedMinRamBytes: 13 * 1024 * 1024 * 1024,
  recommendedMinFreeDiskBytes: 6.5 * 1024 * 1024 * 1024,
});

// Gemma 2: NOT Apache/MIT -- Google's own Gemma Terms of Use is a custom
// license with prohibited-use terms, distinct from every Apache-2.0/MIT
// tier above (same reasoning as Llama 3.2's license note above).
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
  contextSize: 4096,
  recommendedMinRamBytes: 6 * 1024 * 1024 * 1024,
  recommendedMinFreeDiskBytes: 2.5 * 1024 * 1024 * 1024,
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
  contextSize: 4096,
  recommendedMinRamBytes: 15 * 1024 * 1024 * 1024,
  recommendedMinFreeDiskBytes: 7.5 * 1024 * 1024 * 1024,
});

export const MODEL_TIERS = Object.freeze({
  low: LOW,
  mid: MID,
  high: HIGH,
  'phi-mini': PHI_MINI,
  'phi-14b': PHI_14B,
  'llama-1b': LLAMA_1B,
  'llama-3b': LLAMA_3B,
  'mistral-7b': MISTRAL_7B,
  'granite-2b': GRANITE_2B,
  'granite-8b': GRANITE_8B,
  'gemma-2b': GEMMA_2B,
  'gemma-9b': GEMMA_9B,
});

// Backward-compatible single-spec export -- the MID tier, i.e. exactly what
// this file exported before tiering existed. Any caller that hasn't opted
// into tiering (createModelManager's default `spec` param) keeps working
// unchanged.
export const MODEL_SPEC = MID;

// `totalMemBytes` and `cpuCount` are plain numbers from os.totalmem()/os.cpus(),
// unlike Android's `{ totalMemBytes }` native-plugin object -- registry.js
// unwraps it before calling this) since desktop reads it synchronously
// with no native round-trip involved. Falls back to MID (never null) --
// unlike mobile's fail-safe-to-null-if-underpowered gate, a real
// desktop/laptop's realistic floor is already MID's own 4 GB minimum, so
// there's no meaningfully weaker tier to offer below it.
// `cpuCount` is accepted for backward compatibility with existing callers
// (registry.js passes os.cpus().length) but no longer gates tier
// selection: RAM is the only capacity signal used below. The 7B/1.5B
// quants both fit their tier's RAM floor regardless of core count; a
// low-core machine just generates more slowly within whichever tier it
// qualifies for on RAM alone. Core count used to hard-gate both HIGH
// (require >=8) and MID (require >=8, else force the weak LOW/0.5B tier)
// -- the latter was strict enough to force a real 2-core/16 GB machine
// onto a model too weak to reliably write a report at all (it echoed its
// own instruction prompt back instead -- see llmProvider.js's
// isPromptEcho guard, added after exactly that failure).
export function selectTierForDevice(totalMemBytes, cpuCount = Number.POSITIVE_INFINITY) {
  void cpuCount;
  if (typeof totalMemBytes !== 'number') return MID; // no RAM signal -> safe default
  if (totalMemBytes >= HIGH.recommendedMinRamBytes) return HIGH;
  if (totalMemBytes >= MID.recommendedMinRamBytes) return MID;
  return LOW;
}
