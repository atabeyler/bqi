import { describe, expect, it } from 'vitest';
import { computeRiskScore } from '../src/services/risk.js';
import { comparePostureStates } from '../src/services/postureDrift.js';
import { forecastRiskTrend } from '../src/services/riskForecast.js';
import { rankDecisionActions, simulateDigitalTwin } from '../src/services/cyberDecision.js';
import { mapComplianceEvidence } from '../src/services/compliance.js';
import { mapRuleToTechnique } from '../src/services/attackMapping.js';
import { exportCycloneDx, exportSpdx, normalizeSbomDocument } from '../src/intelligence/sbom.js';

describe('deterministic risk model v2', () => {
  it('raises risk for exposure/path/business evidence and explains each input', () => {
    const baseline = computeRiskScore({ cvssScore: 7, confidenceScore: 80 });
    const contextual = computeRiskScore({
      cvssScore: 7,
      confidenceScore: 80,
      internetExposure: 1,
      attackPathReachability: 0.8,
      businessImpact: 1,
    });
    expect(contextual.score).toBeGreaterThan(baseline.score);
    expect(contextual.breakdown).toMatchObject({ internetExposure: 1, attackPathReachability: 0.8, businessImpact: 1 });
  });

  it('applies bounded compensating-control reduction without erasing risk', () => {
    const uncontrolled = computeRiskScore({ cvssScore: 8, confidenceScore: 100, internetExposure: 1 });
    const controlled = computeRiskScore({ cvssScore: 8, confidenceScore: 100, internetExposure: 1, compensatingControlEffectiveness: 1 });
    expect(controlled.score).toBeLessThan(uncontrolled.score);
    expect(controlled.score).toBeGreaterThan(0);
    expect(controlled.breakdown.controlReduction).toBe(0.6);
  });
});

describe('baseline and drift', () => {
  it('detects exposure, privilege, vulnerability, control, and path regressions', () => {
    const before = {
      id: 'before',
      entities: [{ entityType: 'IDENTITY', externalKey: 'admin', attributes: { public: false, permissions: [], vulnerabilities: [] }, fingerprint: 'a' }],
      relationships: [],
      controls: [{ externalKey: 'mfa', status: 'EFFECTIVE', effectiveness: 1 }],
    };
    const after = {
      id: 'after',
      entities: [{ entityType: 'IDENTITY', externalKey: 'admin', attributes: { public: true, permissions: ['*'], vulnerabilities: ['CVE-2099-1'] }, fingerprint: 'b' }],
      relationships: [{ sourceType: 'IDENTITY', sourceKey: 'admin', relationshipType: 'CAN_ACCESS', targetType: 'DATABASE', targetKey: 'prod' }],
      controls: [],
    };
    const result = comparePostureStates(before, after);
    expect(result.securityRegression).toBe(true);
    expect(result.newExposures).toEqual(['IDENTITY:admin']);
    expect(result.newPrivileges).toEqual(['IDENTITY:admin']);
    expect(result.newVulnerabilities).toEqual([{ entity: 'IDENTITY:admin', cveId: 'CVE-2099-1' }]);
    expect(result.removedControls).toEqual(['mfa']);
    expect(result.reopenedAttackPaths).toHaveLength(1);
  });
});

describe('risk forecasting', () => {
  it('does not forecast without enough history', () => {
    expect(forecastRiskTrend([{ computedAt: '2026-01-01', riskScore: 10 }]).status).toBe('INSUFFICIENT_DATA');
  });

  it('returns a confidence-bearing trend when history is sufficient', () => {
    const result = forecastRiskTrend([
      { computedAt: '2026-01-01', riskScore: 20 },
      { computedAt: '2026-01-11', riskScore: 30 },
      { computedAt: '2026-01-21', riskScore: 40 },
      { computedAt: '2026-01-31', riskScore: 50 },
    ], 10);
    expect(result.status).toBe('FORECAST_AVAILABLE');
    expect(result.forecast.direction).toBe('INCREASING');
    expect(result.confidence).toBeGreaterThan(0);
  });
});

describe('digital twin and decision optimization', () => {
  const findings = [
    { id: 'f1', title: 'Critical CVE', target: 'edge', category: 'SCA', cve_ids: ['CVE-2099-1000'], status: 'NEW', risk_score: 90, confidence_score: 90 },
    { id: 'f2', title: 'Weak DNS', target: 'example.com', category: 'DNS_EMAIL_SECURITY', cve_ids: [], status: 'NEW', risk_score: 30, confidence_score: 80 },
  ];

  it('simulates patching against an isolated snapshot with before/after delta', () => {
    const result = simulateDigitalTwin({ graphSnapshotHash: 'abc', findings, relationships: [] }, { type: 'PATCH_CVE', cveId: 'CVE-2099-1000' });
    expect(result.riskBefore).toBe(120);
    expect(result.estimatedRiskAfter).toBe(30);
    expect(result.affectedFindings[0]).toMatchObject({ findingId: 'f1', after: 0 });
  });

  it('uses the exact classical solver to maximize modeled risk reduction', () => {
    const result = rankDecisionActions(findings, 2);
    expect(result.solver).toBe('exact-dp-knapsack');
    expect(result.recommendations.map((item) => item.findingId)).toContain('f1');
  });

  it('deduplicates the same patch across correlated findings', () => {
    const result = rankDecisionActions([
      ...findings,
      { ...findings[0], id: 'f3', title: 'Same CVE on another component' },
    ], 2);
    const patch = result.recommendations.find((item) => item.action.type === 'PATCH_CVE');
    expect(patch.findingIds).toEqual(expect.arrayContaining(['f1', 'f3']));
    expect(result.recommendations.filter((item) => item.action.type === 'PATCH_CVE')).toHaveLength(1);
  });
});

describe('evidence-gated mappings', () => {
  it('maps only exact observed rule IDs to ATT&CK', () => {
    expect(mapRuleToTechnique('BCI-IAM-MFA')).toMatchObject({ techniqueId: 'T1078' });
    expect(mapRuleToTechnique('made-up-rule')).toBeNull();
  });

  it('does not claim compliance and ignores mappings without evidence', () => {
    const results = mapComplianceEvidence([
      { findingId: 'f1', ruleId: 'BCI-IAM-MFA', evidenceId: 'e1' },
      { findingId: 'f2', ruleId: 'BCI-CLOUD-PUBLIC', evidenceId: null },
    ]);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.status === 'NON_COMPLIANT' && result.findingId === 'f1')).toBe(true);
  });
});

describe('SBOM intelligence', () => {
  const cycloneDx = {
    bomFormat: 'CycloneDX', specVersion: '1.6',
    components: [
      { type: 'application', 'bom-ref': 'app', name: 'app', version: '1' },
      { type: 'library', 'bom-ref': 'lib', name: 'lib', version: '2', purl: 'pkg:npm/lib@2' },
    ],
    dependencies: [{ ref: 'app', dependsOn: ['lib'] }],
  };

  it('ingests CycloneDX components and dependency edges', () => {
    const result = normalizeSbomDocument('CYCLONEDX', cycloneDx);
    expect(result.entities).toHaveLength(2);
    expect(result.relationships).toEqual([expect.objectContaining({ sourceKey: 'app', targetKey: 'lib', type: 'DEPENDS_ON' })]);
  });

  it('exports both CycloneDX and SPDX without inventing package claims', () => {
    const facts = normalizeSbomDocument('CYCLONEDX', cycloneDx);
    expect(exportCycloneDx(facts.entities, facts.relationships)).toMatchObject({ bomFormat: 'CycloneDX', specVersion: '1.7' });
    expect(exportSpdx(facts.entities, facts.relationships)).toMatchObject({ spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0' });
  });
});
