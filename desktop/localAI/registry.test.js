import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selectProvider, configureLocalLLM, getModelManager, setModelTier, listModelTiers } from './registry.js';
import { MODEL_TIERS } from './modelSpec.js';

describe('selectProvider', () => {
  it('selects offline-extractive today (the only registered, always-available provider)', () => {
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

// Settings > Local AI's manual tier picker (see registry.js's setModelTier
// comment for why a saved choice must outlive a restart). Uses a temp dir
// via configureLocalLLM rather than the module's real ~/.bqi
// fallback so these tests never touch the machine's actual home directory.
describe('model tier picker', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bqi-tier-'));
    configureLocalLLM({ modelsDir: path.join(tmpDir, 'models') });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists every pinned tier with picker-relevant fields', () => {
    const tiers = listModelTiers();
    // Derived from MODEL_TIERS itself, not a hardcoded list -- a fixed
    // array here needs editing (and silently under-covers new tiers in
    // the meantime) every time a tier is added, which is exactly what
    // broke CI for real when the Llama/Mistral/Granite/Gemma families
    // were added without updating a hardcoded list in this test.
    expect(tiers.map((t) => t.tier).sort()).toEqual(Object.keys(MODEL_TIERS).sort());
    expect(tiers.every((t) => typeof t.sizeBytes === 'number' && t.displayLabel)).toBe(true);
  });

  it('repoints modelManager at the chosen tier', () => {
    setModelTier('high');
    expect(getModelManager().spec.tier).toBe('high');
  });

  it('rejects an unknown tier key instead of silently keeping the old one', () => {
    expect(() => setModelTier('ultra')).toThrow('unknown_model_tier');
    expect(getModelManager().spec.tier).not.toBe('ultra');
  });

  it('persists the choice to a preference file next to modelsDir, so it survives a restart', () => {
    setModelTier('high');
    const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, 'model-tier-preference.json'), 'utf-8'));
    expect(saved.tier).toBe('high');
  });
});
