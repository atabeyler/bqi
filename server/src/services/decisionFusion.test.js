import { describe, it, expect } from 'vitest';
import { fuseDecision } from './decisionFusion.js';

describe('fuseDecision', () => {
  it('reports no-quantum-engines-ran when only the AI narrative claim is present', () => {
    const fusion = fuseDecision([{ claim: 'ai-narrative', engine: 'ai', verified: false, confidence: null }]);
    expect(fusion.agreementLevel).toBe('no-quantum-engines-ran');
    expect(fusion.engineCount).toBe(0);
  });

  it('reports consistent when every engine agrees with its classical baseline', () => {
    const evidence = [
      { engine: 'ai', verified: false, confidence: null },
      { engine: 'scenario-quantum', verified: false, confidence: 'agrees-with-classical-baseline' },
      { engine: 'fraud-quantum-kernel', verified: true, confidence: '90% agreement with classical baseline' },
    ];
    const fusion = fuseDecision(evidence);
    expect(fusion.agreementLevel).toBe('consistent');
    expect(fusion.engineCount).toBe(2);
    expect(fusion.verifiedOnHardwareCount).toBe(1);
  });

  it('reports partial-disagreement when a quantum engine diverges from its classical baseline', () => {
    const evidence = [
      { engine: 'ai', verified: false, confidence: null },
      { engine: 'scenario-quantum', verified: false, confidence: 'diverges-from-classical-baseline' },
    ];
    const fusion = fuseDecision(evidence);
    expect(fusion.agreementLevel).toBe('partial-disagreement');
    expect(fusion.summary).toContain('1 tanesi klasik taban çizgisinden farklı');
  });
});
