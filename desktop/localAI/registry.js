import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { queryOffline } from './offlineExtractive.js';
import { createModelManager } from './modelManager.js';
import { createLLMQuery } from './llmProvider.js';
import { MODEL_TIERS, selectTierForDevice } from './modelSpec.js';

// Ordered by preference:
//   1. local-llm    -- real generative inference (Qwen2.5-1.5B-Instruct,
//                       GGUF, via node-llama-cpp). isAvailable() is a cheap
//                       sync "is the model file on disk" check; the
//                       heavier RAM/CPU/disk gate runs per-request inside
//                       llmProvider.js and throws a distinguishable error
//                       if the device turns out unable to run it, which
//                       the Analysis Router (client/src/services/
//                       analysisRouter.js) catches and falls through on.
//   2. offline-extractive -- the original read-only keyword/summary/
//                       compare engine (offlineExtractive.js), unchanged,
//                       always available for chat-mode archive queries.
//                       Deliberately NOT a fallback for a "generate a new
//                       analysis" request when local-llm is unavailable --
//                       see this file's own offline-extractive createQuery
//                       for why (a "new analysis" must never silently
//                       become an old-report synthesis).
//
// provider.js and everything above it (main.js's ai:query IPC handler, the
// renderer) never need to change to pick up a new provider here -- this
// file is the only thing that needs a new entry, per the original seam
// design (see the comment history in provider.js).
let modelsDir = path.join(os.homedir(), '.bqi', 'models');

// A user can override the auto-selected tier from Settings > Local AI
// (Model Manager: remove the current model, pick a different tier, then
// download it -- see main.js's ai:modelSelectTier handler). That choice is
// saved next to the models themselves so it survives an app restart --
// without this, setModelTier() would only last until the next launch,
// which re-derives the tier from RAM alone and silently reverts a
// deliberate choice (e.g. someone accepting HIGH's slower generation on a
// low-core machine, exactly the case this file's tiering logic exists
// for). Best-effort: a read/write failure here just means the manual
// choice doesn't persist, never a crash.
function tierPreferencePath() {
  return path.join(path.dirname(modelsDir), 'model-tier-preference.json');
}

function readTierPreference() {
  try {
    const { tier } = JSON.parse(fs.readFileSync(tierPreferencePath(), 'utf-8'));
    return MODEL_TIERS[tier] ? tier : null;
  } catch {
    return null;
  }
}

function writeTierPreference(tier) {
  try {
    fs.mkdirSync(path.dirname(tierPreferencePath()), { recursive: true });
    fs.writeFileSync(tierPreferencePath(), JSON.stringify({ tier }), 'utf-8');
  } catch {
    // Best-effort persistence -- see the comment above tierPreferencePath.
  }
}

// Device-tiered model selection (mirrors client/src/mobile/localAI/
// registry.js's own tiering) unless a saved manual choice exists, in which
// case that wins outright.
function resolveSpec() {
  const preferred = readTierPreference();
  return preferred ? MODEL_TIERS[preferred] : selectTierForDevice(os.totalmem(), os.cpus().length);
}

let modelManager = createModelManager({ modelsDir, spec: resolveSpec() });

// Called once from desktop/main.js's startup sequence with Electron's real
// app.getPath('userData')-based path, so the model lives next to the rest
// of this app's user data instead of the ~/.bqi fallback above (that
// fallback exists purely so this module -- and its tests -- work without
// Electron ever being imported here).
export function configureLocalLLM({ modelsDir: dir } = {}) {
  if (dir && dir !== modelsDir) {
    modelsDir = dir;
    modelManager = createModelManager({ modelsDir, spec: resolveSpec() });
  }
  return modelManager;
}

export function getModelManager() {
  return modelManager;
}

// Settings > Local AI: manual tier override (see the comment above
// tierPreferencePath). Switching tiers only repoints modelManager at a
// different pinned model -- it does NOT download or delete any file, so
// the caller (main.js's ai:modelSelectTier handler) is expected to have
// the UI remove the old model first (a different tier is a different
// filename; the old one would otherwise sit on disk unused, which is
// harmless but wasteful) and prompt a fresh download for the new one.
export function setModelTier(tierKey) {
  const spec = MODEL_TIERS[tierKey];
  if (!spec) throw new Error(`unknown_model_tier: ${tierKey}`);
  writeTierPreference(tierKey);
  modelManager = createModelManager({ modelsDir, spec });
  return modelManager;
}

// Settings UI data source: every pinned tier's picker-relevant fields, not
// the whole frozen spec object (skips url/sha256 -- internal to
// modelManager's own download/verify, nothing a picker needs to render).
export function listModelTiers() {
  return Object.entries(MODEL_TIERS).map(([tier, spec]) => ({
    tier,
    id: spec.id,
    label: spec.label,
    displayLabel: spec.displayLabel,
    sizeBytes: spec.sizeBytes,
    contextSize: spec.contextSize,
    recommendedMinRamBytes: spec.recommendedMinRamBytes,
    recommendedMinFreeDiskBytes: spec.recommendedMinFreeDiskBytes,
  }));
}

const PROVIDERS = [
  {
    capability: 'local-llm',
    isAvailable: () => modelManager.isAvailable(),
    createQuery: (ctx) => createLLMQuery({ ...ctx, modelManager }),
  },
  {
    capability: 'offline-extractive',
    isAvailable: () => true, // no model download or network dependency
    createQuery: ({ db, userId }) => (request) => {
      // A "generate a new analysis" request must never silently become a
      // synthesis of unrelated past reports -- that read like a real
      // generated analysis of the requested topic but was actually just
      // related old report text stitched together (synthesizeFromArchive
      // stays available below for explicit chat-mode archive queries:
      // "past reports about X", "summarize report Y", etc., where the user
      // is knowingly asking about history, not requesting something new).
      // Without a real local LLM there is no offline capability to
      // generate a genuinely new analysis -- say so honestly (provider.js
      // turns this into { ok: false, ... }, which the Analysis Router
      // surfaces as AllEnginesUnavailableError) instead of returning a
      // misleading document.
      if (request?.mode === 'generate') {
        throw new Error('offline_generation_unavailable');
      }
      return queryOffline(db, userId, request);
    },
  },
];

export function selectProvider() {
  return PROVIDERS.find((p) => p.isAvailable()) ?? PROVIDERS[PROVIDERS.length - 1];
}

export { PROVIDERS };
