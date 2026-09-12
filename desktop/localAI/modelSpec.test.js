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

  it('offers a second (Phi-4) model family manually, alongside the Qwen2.5 tiers', () => {
    expect(MODEL_TIERS['phi-mini'].id).toBe('phi-4-mini-instruct-q4_k_m');
    expect(MODEL_TIERS['phi-mini'].license).toBe('MIT');
    expect(MODEL_TIERS['phi-14b'].id).toBe('phi-4-q4_k_m');
    expect(MODEL_TIERS['phi-14b'].license).toBe('MIT');
  });

  it('offers Llama 3.2, Mistral, Granite, and Gemma 2 manually too, alongside Qwen2.5/Phi-4', () => {
    expect(MODEL_TIERS['llama-1b'].id).toBe('llama-3.2-1b-instruct-q4_k_m');
    expect(MODEL_TIERS['llama-3b'].id).toBe('llama-3.2-3b-instruct-q4_k_m');
    expect(MODEL_TIERS['mistral-7b'].id).toBe('mistral-7b-instruct-v0.3-q4_k_m');
    expect(MODEL_TIERS['mistral-7b'].license).toBe('Apache-2.0');
    expect(MODEL_TIERS['granite-2b'].id).toBe('granite-3.1-2b-instruct-q4_k_m');
    expect(MODEL_TIERS['granite-2b'].license).toBe('Apache-2.0');
    expect(MODEL_TIERS['granite-8b'].id).toBe('granite-3.1-8b-instruct-q4_k_m');
    expect(MODEL_TIERS['granite-8b'].license).toBe('Apache-2.0');
    expect(MODEL_TIERS['gemma-2b'].id).toBe('gemma-2-2b-it-q4_k_m');
    expect(MODEL_TIERS['gemma-9b'].id).toBe('gemma-2-9b-it-q4_k_m');
    // Llama 3.2 and Gemma 2 carry their own custom (non-Apache/MIT)
    // licenses -- distinct enough from every other tier's permissive
    // license that a picker showing just "Q LOCAL ... Model" without the
    // brand would obscure a real, informed-consent-worthy difference.
    expect(MODEL_TIERS['llama-1b'].license).toBe('Llama 3.2 Community License');
    expect(MODEL_TIERS['llama-3b'].license).toBe('Llama 3.2 Community License');
    expect(MODEL_TIERS['gemma-2b'].license).toBe('Gemma Terms of Use');
    expect(MODEL_TIERS['gemma-9b'].license).toBe('Gemma Terms of Use');
    // Exactly these 12 tiers -- nothing else sneaked in.
    expect(Object.keys(MODEL_TIERS).sort()).toEqual([
      'gemma-2b', 'gemma-9b', 'granite-2b', 'granite-8b', 'high', 'llama-1b', 'llama-3b',
      'low', 'mid', 'mistral-7b', 'phi-14b', 'phi-mini',
    ]);
  });
});

describe('selectTierForDevice', () => {
  it('falls back to MID when there is no RAM signal', () => {
    expect(selectTierForDevice(undefined)).toBe(MODEL_TIERS.mid);
    expect(selectTierForDevice(null)).toBe(MODEL_TIERS.mid);
  });

  it('selects MID for a typical 4-11 GB desktop, regardless of core count', () => {
    expect(selectTierForDevice(4 * 1024 ** 3)).toBe(MODEL_TIERS.mid);
    expect(selectTierForDevice(8 * 1024 ** 3)).toBe(MODEL_TIERS.mid);
    expect(selectTierForDevice(11 * 1024 ** 3)).toBe(MODEL_TIERS.mid);
    // A low-core machine (e.g. a 2-core/4-thread laptop) with 4+ GB RAM
    // used to be forced onto the weak LOW/0.5B tier by a blanket
    // cpuCount<8 rule -- weak enough to fail real requests outright (see
    // llmProvider.js's isPromptEcho guard). Core count no longer gates
    // tier selection at all; RAM alone decides.
    expect(selectTierForDevice(4 * 1024 ** 3, 2)).toBe(MODEL_TIERS.mid);
  });

  it('selects HIGH whenever RAM meets its floor, regardless of core count', () => {
    expect(selectTierForDevice(12 * 1024 ** 3, 8)).toBe(MODEL_TIERS.high);
    expect(selectTierForDevice(32 * 1024 ** 3, 16)).toBe(MODEL_TIERS.high);
    // Core count used to gate HIGH (require >=8); a real 2-core/16 GB
    // machine now still qualifies on RAM alone -- generation is slower,
    // but that's a user-accepted tradeoff, not a hard block.
    expect(selectTierForDevice(16 * 1024 ** 3, 4)).toBe(MODEL_TIERS.high);
    expect(selectTierForDevice(12 * 1024 ** 3, 2)).toBe(MODEL_TIERS.high);
  });

  it('selects LOW when RAM is below MID\'s floor, regardless of core count', () => {
    expect(selectTierForDevice(2 * 1024 ** 3, 4)).toBe(MODEL_TIERS.low);
    expect(selectTierForDevice(2 * 1024 ** 3, 16)).toBe(MODEL_TIERS.low);
  });

  it('never auto-selects the Phi-4 tiers -- those are manual-only, even on a very high-RAM machine', () => {
    expect(selectTierForDevice(64 * 1024 ** 3, 16)).toBe(MODEL_TIERS.high);
    expect(selectTierForDevice(128 * 1024 ** 3, 32)).toBe(MODEL_TIERS.high);
  });
});
