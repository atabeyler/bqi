import { describe, it, expect } from 'vitest';
import { planEngines, candidateEnginesForTargetType, availableCapabilitiesForTargetType } from '../src/services/analysisPlanner.js';
import { getCapability, listCapabilities, registerCapability } from '../src/engines/capabilities.js';
import { registerAdapter, unregisterAdapter } from '../src/engines/registry.js';

describe('planEngines (pure)', () => {
  it('plans passive repository engines', () => expect(planEngines('REPOSITORY', 'PASSIVE').map((p) => p.engineId).sort()).toEqual(['bci-posture-intelligence','osv-scanner','semgrep','trivy']));
  it('plans passive evidence analysis without enabling active web engines', () => expect(planEngines('DOMAIN', 'PASSIVE').map((p) => p.engineId)).toEqual(['bci-posture-intelligence']));
  it('plans safe-active web and hostname discovery engines without restricted engines', () => expect(planEngines('DOMAIN', 'SAFE_ACTIVE').map((p) => p.engineId).sort()).toEqual(['bci-posture-intelligence','http-fuzz','naabu','nuclei']));
  it('maps every advanced capability to its real adapter', () => {
    expect(planEngines('DOMAIN','SAFE_ACTIVE','FUZZ').map((p)=>p.engineId)).toEqual(['http-fuzz']);
    expect(planEngines('DOMAIN','RESTRICTED','INTRUSIVE').map((p)=>p.engineId)).toEqual(['intrusive-validation']);
    expect(planEngines('DOMAIN','RESTRICTED','DOS').map((p)=>p.engineId)).toEqual(['availability-probe']);
  });
  it('does not run restricted adapters below RESTRICTED', () => {
    expect(planEngines('DOMAIN','SAFE_ACTIVE','INTRUSIVE')).toEqual([]);
    expect(planEngines('DOMAIN','AUTHENTICATED','DOS')).toEqual([]);
  });
  it('returns no plan for unknown capabilities', () => expect(planEngines('DOMAIN','RESTRICTED','DOES_NOT_EXIST')).toEqual([]));
});

describe('dynamic capability registry', () => {
  it('ships the advanced capabilities', () => expect(listCapabilities().map((c)=>c.id)).toEqual(expect.arrayContaining(['FUZZ','INTRUSIVE','DOS'])));
  it('keeps intrusiveness classes out of the capability registry', () => {
    for (const id of ['PASSIVE', 'SAFE_ACTIVE', 'AUTHENTICATED', 'RESTRICTED']) expect(getCapability(id)).toBeNull();
  });
  it('accepts future capabilities and adapters without planner rewrites', () => {
    registerCapability({ id:'CUSTOM_ANALYSIS', name:'Custom Analysis' });
    expect(getCapability('CUSTOM_ANALYSIS')?.name).toBe('Custom Analysis');
    registerAdapter({
      id: 'custom-test-engine', name: 'Custom test engine', license: 'TEST', intrusiveness: 'PASSIVE',
      capabilities: ['CUSTOM_ANALYSIS'], supportedAnalysisTypes: ['CUSTOM_ANALYSIS'], supportedTargetTypes: ['CLOUD_ACCOUNT'],
      async healthCheck() { return { status: 'HEALTHY' }; }, async execute() { return { raw: [] }; },
    });
    try {
      expect(planEngines('CLOUD_ACCOUNT','PASSIVE','CUSTOM_ANALYSIS').map((plan) => plan.engineId)).toEqual(['custom-test-engine']);
    } finally {
      unregisterAdapter('custom-test-engine');
    }
  });
  it('reports real target support', () => {
    const caps=availableCapabilitiesForTargetType('DOMAIN');
    for (const id of ['WEB','FUZZ','NETWORK_DISCOVERY','INTRUSIVE','DOS']) expect(caps.find((c)=>c.id===id)?.supported).toBe(true);
    expect(caps.find((c)=>c.id==='ADVANCED_API_SECURITY')?.supported).toBe(false);
    expect(availableCapabilitiesForTargetType('API').find((c)=>c.id==='API')?.supported).toBe(true);
  });
});

describe('candidateEnginesForTargetType', () => {
  it('lists all registered DOMAIN candidates', () => expect(candidateEnginesForTargetType('DOMAIN').map((p)=>p.engineId).sort()).toEqual(['availability-probe','bci-posture-intelligence','http-fuzz','intrusive-validation','naabu','nuclei']));
});
