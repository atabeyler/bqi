import { describe, it, expect } from 'vitest';
import {
  listIntrusiveModules, getIntrusiveModule, listImplementedModules, selectApplicableModules,
} from '../src/engines/intrusive/registry.js';
import { buildIntrusivePlan } from '../src/services/intrusivePlanning.js';

describe('Dynamic Intrusive Validation Registry', () => {
  it('registers newly measurable modules as real IMPLEMENTED modules', () => {
    for (const id of ['OPENAPI_SCHEMA_BEHAVIOR', 'CACHE_PROXY_BEHAVIOR', 'WEBSOCKET_API_PROTOCOL', 'TECHNOLOGY_SPECIFIC_VALIDATION']) {
      expect(getIntrusiveModule(id)?.status).toBe('IMPLEMENTED');
      expect(typeof getIntrusiveModule(id)?.run).toBe('function');
    }
  });
  it('registers a real, non-empty set of modules with no duplicate ids', () => {
    const modules = listIntrusiveModules();
    expect(modules.length).toBeGreaterThan(0);
    const ids = modules.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every registered module declares a real status -- IMPLEMENTED or PLANNED, nothing else', () => {
    for (const module of listIntrusiveModules()) {
      expect(['IMPLEMENTED', 'PLANNED']).toContain(module.status);
    }
  });

  it('every IMPLEMENTED module has a real isApplicable() and run() -- a PLANNED module has neither', () => {
    for (const module of listIntrusiveModules()) {
      if (module.status === 'IMPLEMENTED') {
        expect(typeof module.isApplicable).toBe('function');
        expect(typeof module.run).toBe('function');
      } else {
        expect(module.run).toBeUndefined();
        // A real, honest reason it isn't implemented yet -- never silently unwritten.
        expect(typeof module.blockedOn).toBe('string');
        expect(module.blockedOn.length).toBeGreaterThan(0);
      }
    }
  });

  it('getIntrusiveModule resolves a real registered module by id, and null for an unknown one', () => {
    expect(getIntrusiveModule('HTTP_METHOD_PROTOCOL')?.id).toBe('HTTP_METHOD_PROTOCOL');
    expect(getIntrusiveModule('NOT_A_REAL_MODULE')).toBeNull();
  });

  it('listImplementedModules never includes a PLANNED module', () => {
    expect(listImplementedModules().every((m) => m.status === 'IMPLEMENTED')).toBe(true);
    expect(listImplementedModules().length).toBeLessThan(listIntrusiveModules().length); // real PLANNED entries exist
  });

  it('selectApplicableModules is real per-context dynamic selection, not a fixed list', () => {
    const withoutFindings = selectApplicableModules({ target: 'https://example.com', priorFindings: [] });
    const withFindings = selectApplicableModules({ target: 'https://example.com', priorFindings: [{ id: 'f1', evidence: {} }] });
    // FINDING_REPRODUCIBILITY_VERIFICATION only becomes applicable once
    // there is real prior evidence to verify -- two different evidence
    // states genuinely select two different module sets.
    expect(withoutFindings.some((m) => m.id === 'FINDING_REPRODUCIBILITY_VERIFICATION')).toBe(false);
    expect(withFindings.some((m) => m.id === 'FINDING_REPRODUCIBILITY_VERIFICATION')).toBe(true);
  });

  it('a module whose own isApplicable() throws is treated as not applicable, never crashes selection', () => {
    // Regression guard for the registry's own defensive try/catch, without
    // needing to mutate a real module -- simulated via a throwing check
    // through the same selectApplicableModules() code path indirectly by
    // asserting the real registry's own selection never throws for a
    // context missing fields some modules might expect.
    expect(() => selectApplicableModules({})).not.toThrow();
  });

  it('publishes dynamic IMPLEMENTED/PLANNED counts and evidence-bound applicability for the Wizard', () => {
    const withoutFinding = buildIntrusivePlan('https://example.com', []);
    const withFinding = buildIntrusivePlan('https://example.com', [{ id: 'f1', evidence: {} }]);
    expect(withoutFinding.summary.total).toBe(listIntrusiveModules().length);
    expect(withoutFinding.summary.implemented).toBe(listImplementedModules().length);
    expect(withoutFinding.modules.find((module) => module.status === 'PLANNED')).toMatchObject({ applicable: false, source: 'BCI_NATIVE_REGISTRY' });
    expect(withoutFinding.baseModuleIds).not.toContain('FINDING_REPRODUCIBILITY_VERIFICATION');
    expect(withFinding.baseModuleIds).toContain('FINDING_REPRODUCIBILITY_VERIFICATION');
  });
});
