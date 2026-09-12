import { describe, it, expect } from 'vitest';
import { selectProvider, refreshInstalledState, getModelManager, getDeviceInfo, setModelTier, listModelTiers } from './registry.js';
import { MODEL_TIERS } from './modelSpec.js';

describe('selectProvider', () => {
  it('selects offline-extractive today (no native LocalLLM plugin registered in this test env)', () => {
    const provider = selectProvider();
    expect(provider.capability).toBe('offline-extractive');
    expect(provider.isAvailable()).toBe(true);
  });

  it('createQuery returns a callable bound to the given db/userId', () => {
    const provider = selectProvider();
    const run = provider.createQuery({ db: {}, userId: 'BOLD-001' });
    expect(typeof run).toBe('function');
  });
});

// Real behavior in a Node/vitest environment: there is no window.Capacitor,
// so getNativeDeviceInfo() (llmRuntime.js) always resolves null here --
// refreshInstalledState() must still fail safe onto the MID tier (never
// throw, never leave modelManager undefined) rather than assume a tier.
describe('refreshInstalledState (device tiering)', () => {
  it('falls back to the MID tier when no native device-info signal exists', async () => {
    await refreshInstalledState();
    expect(getModelManager().spec.id).toBe(MODEL_TIERS.mid.id);
    expect(getDeviceInfo()).toBeNull();
  });
});

// Settings > Local AI's manual tier picker (mirrors desktop/localAI/
// registry.js's, minus on-device persistence -- see setModelTier's comment).
describe('model tier picker', () => {
  it('lists every pinned tier with picker-relevant fields', () => {
    const tiers = listModelTiers();
    // Derived from MODEL_TIERS itself, not a hardcoded list -- this test's
    // job is "every pinned tier shows up", which a fixed array would need
    // editing (and silently under-cover) every time a tier is added, same
    // failure mode this test hit for real when the Llama/Mistral/Granite/
    // Gemma families were added without updating a hardcoded list here.
    expect(tiers.map((t) => t.tier).sort()).toEqual(Object.keys(MODEL_TIERS).sort());
    expect(tiers.every((t) => typeof t.sizeBytes === 'number' && t.displayLabel)).toBe(true);
  });

  it('repoints modelManager at the chosen tier and keeps it there on the next refresh, overriding the RAM-derived tier', async () => {
    setModelTier('high');
    expect(getModelManager().spec.id).toBe(MODEL_TIERS.high.id);

    // No native device-info signal in this test env, so an un-overridden
    // refresh would normally fall back to MID (see the describe block
    // above) -- the manual choice must win instead.
    await refreshInstalledState();
    expect(getModelManager().spec.id).toBe(MODEL_TIERS.high.id);
  });

  it('rejects an unknown tier key instead of silently keeping the old one', () => {
    const before = getModelManager().spec.id;
    expect(() => setModelTier('ultra')).toThrow('unknown_model_tier');
    expect(getModelManager().spec.id).toBe(before);
  });
});
