import { describe, it, expect } from 'vitest';
import { ModelRegistry, createDefaultRegistry, registerMissingDefaults } from '../governance/modelRegistry.js';

describe('registry migration: models added after the first boot are registered, nothing else changes', () => {
  it('adds only the missing defaults to a persisted (older) registry and is idempotent', () => {
    const full = createDefaultRegistry();
    const all = full.list();
    const old = all.filter((m) => !/^M6\d|^M7\d/.test(m.model_id)); // a registry persisted before the vNext engines existed
    expect(old.length).toBeLessThan(all.length);
    const reg = new ModelRegistry().loadState(old);
    const before = JSON.stringify(reg.get(old[0].model_id, '1.0.0'));
    const added = registerMissingDefaults(reg);
    expect(added.sort()).toEqual(all.filter((m) => /^M6\d|^M7\d/.test(m.model_id)).map((m) => m.model_id).sort());
    expect(reg.list().length).toBe(all.length);
    expect(JSON.stringify(reg.get(old[0].model_id, '1.0.0'))).toBe(before); // existing record + hash-chained history untouched
    expect(reg.get('M71.system_twin', '1.0.0')).toMatchObject({ state: 'DEVELOPMENT', calibration: 'UNCALIBRATED' });
    expect(registerMissingDefaults(reg)).toEqual([]); // second boot: nothing to do
  });
});
