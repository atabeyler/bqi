import { describe, it, expect } from 'vitest';
import {
  listResilienceModules, getResilienceModule, listImplementedResilienceModules, selectApplicableResilienceModules,
} from '../src/engines/resilience/registry.js';

describe('Dynamic Resilience Registry', () => {
  it('registers a real, non-empty set of modules with no duplicate ids', () => {
    const modules = listResilienceModules();
    expect(modules.length).toBeGreaterThan(0);
    const ids = modules.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every registered module declares a real status -- IMPLEMENTED or PLANNED, nothing else', () => {
    for (const module of listResilienceModules()) {
      expect(['IMPLEMENTED', 'PLANNED']).toContain(module.status);
    }
  });

  it('every IMPLEMENTED module has a real isApplicable() and run() -- a PLANNED module has neither, only a real blockedOn reason', () => {
    for (const module of listResilienceModules()) {
      if (module.status === 'IMPLEMENTED') {
        expect(typeof module.isApplicable).toBe('function');
        expect(typeof module.run).toBe('function');
      } else {
        expect(module.run).toBeUndefined();
        expect(typeof module.blockedOn).toBe('string');
        expect(module.blockedOn.length).toBeGreaterThan(0);
      }
    }
  });

  it('getResilienceModule resolves a real registered module by id, and null for an unknown one', () => {
    expect(getResilienceModule('BASELINE_PERFORMANCE')?.id).toBe('BASELINE_PERFORMANCE');
    expect(getResilienceModule('NOT_A_REAL_MODULE')).toBeNull();
  });

  it('listImplementedResilienceModules never includes a PLANNED module', () => {
    expect(listImplementedResilienceModules().every((m) => m.status === 'IMPLEMENTED')).toBe(true);
    expect(listImplementedResilienceModules().length).toBeLessThan(listResilienceModules().length);
  });

  it('selectApplicableResilienceModules is real per-context dynamic selection, not a fixed list', () => {
    const bare = selectApplicableResilienceModules({ target: 'https://example.com', endpoints: [], priorFindings: [], authHeader: null });
    const withEndpoints = selectApplicableResilienceModules({ target: 'https://example.com', endpoints: ['https://example.com/a', 'https://example.com/b'], priorFindings: [], authHeader: null });
    const withFindings = selectApplicableResilienceModules({ target: 'https://example.com', endpoints: [], priorFindings: [{ id: 'f1', evidence: { endpoint: 'https://example.com/x' } }], authHeader: null });
    const withAuth = selectApplicableResilienceModules({ target: 'https://example.com', endpoints: [], priorFindings: [], authHeader: 'Authorization: Bearer x' });

    expect(bare.some((m) => m.id === 'MULTI_ENDPOINT')).toBe(false);
    expect(withEndpoints.some((m) => m.id === 'MULTI_ENDPOINT')).toBe(true);
    expect(bare.some((m) => m.id === 'CROSS_ENGINE_TARGETED_RESILIENCE')).toBe(false);
    expect(withFindings.some((m) => m.id === 'CROSS_ENGINE_TARGETED_RESILIENCE')).toBe(true);
    expect(bare.some((m) => m.id === 'AUTHENTICATED_LOAD')).toBe(false);
    expect(withAuth.some((m) => m.id === 'AUTHENTICATED_LOAD')).toBe(true);
  });

  it('a module whose own isApplicable() throws is treated as not applicable, never crashes selection', () => {
    expect(() => selectApplicableResilienceModules({})).not.toThrow();
  });
});
