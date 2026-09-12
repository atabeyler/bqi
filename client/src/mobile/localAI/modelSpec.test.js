import { describe, it, expect } from 'vitest';
import { MODEL_TIERS, MODEL_SPEC, selectTierForDevice } from './modelSpec.js';

describe('MODEL_TIERS', () => {
  it('MODEL_SPEC (backward-compat) is the MID tier, unchanged from before tiering existed', () => {
    expect(MODEL_SPEC).toBe(MODEL_TIERS.mid);
    expect(MODEL_SPEC.id).toBe('qwen2.5-1.5b-instruct-q4_k_m');
  });

  it('every tier has a real 64-char hex sha256 and a positive size', () => {
    for (const tier of Object.values(MODEL_TIERS)) {
      expect(tier.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(tier.sizeBytes).toBeGreaterThan(0);
    }
  });

  it('offers a second (Phi-4 Mini) model family manually, alongside the Qwen2.5 tiers -- no phi-14b on Android', () => {
    expect(MODEL_TIERS['phi-mini'].id).toBe('phi-4-mini-instruct-q4_k_m');
    expect(MODEL_TIERS['phi-mini'].license).toBe('MIT');
    expect(MODEL_TIERS['phi-14b']).toBeUndefined();
  });

  it('offers Llama 3.2, Granite, and Gemma 2 (including the larger siblings) manually too, alongside Qwen2.5/Phi-4', () => {
    expect(MODEL_TIERS['llama-1b'].id).toBe('llama-3.2-1b-instruct-q4_k_m');
    expect(MODEL_TIERS['llama-1b'].license).toBe('Llama 3.2 Community License');
    expect(MODEL_TIERS['llama-3b'].id).toBe('llama-3.2-3b-instruct-q4_k_m');
    expect(MODEL_TIERS['mistral-7b'].id).toBe('mistral-7b-instruct-v0.3-q4_k_m');
    expect(MODEL_TIERS['mistral-7b'].license).toBe('Apache-2.0');
    expect(MODEL_TIERS['granite-2b'].id).toBe('granite-3.1-2b-instruct-q4_k_m');
    expect(MODEL_TIERS['granite-2b'].license).toBe('Apache-2.0');
    expect(MODEL_TIERS['granite-8b'].id).toBe('granite-3.1-8b-instruct-q4_k_m');
    expect(MODEL_TIERS['gemma-2b'].id).toBe('gemma-2-2b-it-q4_k_m');
    expect(MODEL_TIERS['gemma-2b'].license).toBe('Gemma Terms of Use');
    expect(MODEL_TIERS['gemma-9b'].id).toBe('gemma-2-9b-it-q4_k_m');
    // phi-14b alone stays excluded (its 9GB file is what actually
    // triggered the documented OOM-kill crash history -- see PHI_MINI's
    // own comment), unlike the other, more modest large siblings above.
    expect(MODEL_TIERS['phi-14b']).toBeUndefined();
    // Exactly these 11 tiers -- nothing else sneaked in.
    expect(Object.keys(MODEL_TIERS).sort()).toEqual([
      'gemma-2b', 'gemma-9b', 'granite-2b', 'granite-8b', 'high', 'llama-1b', 'llama-3b',
      'low', 'mid', 'mistral-7b', 'phi-mini',
    ]);
  });
});

describe('selectTierForDevice', () => {
  it('returns null (fail safe) when there is no RAM signal', () => {
    expect(selectTierForDevice(null)).toBeNull();
    expect(selectTierForDevice({})).toBeNull();
  });

  it('returns null for a device below the LOW floor', () => {
    expect(selectTierForDevice({ totalMemBytes: 2 * 1024 ** 3 })).toBeNull();
  });

  it('selects LOW for a 3-6 GB device', () => {
    expect(selectTierForDevice({ totalMemBytes: 4 * 1024 ** 3 })).toBe(MODEL_TIERS.low);
  });

  it('selects MID for a 6-8 GB device (matches the desktop model choice)', () => {
    expect(selectTierForDevice({ totalMemBytes: 6 * 1024 ** 3 })).toBe(MODEL_TIERS.mid);
    expect(selectTierForDevice({ totalMemBytes: 7 * 1024 ** 3 })).toBe(MODEL_TIERS.mid);
  });

  it('still caps an 8-12 GB device at MID -- below HIGH’s own 12 GB floor', () => {
    expect(selectTierForDevice({ totalMemBytes: 8 * 1024 ** 3 })).toBe(MODEL_TIERS.mid);
    expect(selectTierForDevice({ totalMemBytes: 11 * 1024 ** 3 })).toBe(MODEL_TIERS.mid);
  });

  it('selects HIGH for a 12 GB+ device', () => {
    expect(selectTierForDevice({ totalMemBytes: 12 * 1024 ** 3 })).toBe(MODEL_TIERS.high);
    expect(selectTierForDevice({ totalMemBytes: 16 * 1024 ** 3 })).toBe(MODEL_TIERS.high);
  });

  it('never auto-selects the Phi-4 Mini tier -- manual-only, even on a very high-RAM phone', () => {
    expect(selectTierForDevice({ totalMemBytes: 32 * 1024 ** 3 })).toBe(MODEL_TIERS.high);
  });
});
