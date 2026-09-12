import { describe, expect, it } from 'vitest';
import { analyzePostureSnapshot } from '../src/engines/adapters/postureIntelligence.js';
import { mapRuleToTechnique } from '../src/services/attackMapping.js';
import { computeRiskScore, RISK_MODEL_VERSION } from '../src/services/risk.js';
import { exportCycloneDx, normalizeSbomDocument } from '../src/intelligence/sbom.js';
import { simulateDigitalTwin } from '../src/services/cyberDecision.js';

function aiSnapshot() {
  return {
    schemaVersion: '1.1', source: 'approved-ai-posture-export', collectedAt: '2026-09-09T08:00:00.000Z',
    entities: [
      { type: 'AI_APPLICATION', key: 'ai-app:finance', attributes: { untrustedInputReachable: true, promptBoundaryEnforced: false, sensitiveContextReachable: true, contextDlpEnforced: false } },
      { type: 'AI_AGENT', key: 'agent:analyst', attributes: { autonomousAction: true, humanApprovalRequired: false, permissions: ['admin'] } },
      { type: 'MCP_SERVER', key: 'mcp:unknown', attributes: { shadow: true, ownerKnown: false, tokenPassthrough: true, audienceValidation: false } },
      { type: 'MCP_TOOL', key: 'tool:shell', attributes: { definitionChanged: true, definitionIntegrityVerified: false, commandFromContext: true, argumentValidation: false } },
      { type: 'WORKLOAD_IDENTITY', key: 'spiffe://prod.example/agent/analyst', attributes: { spiffeId: 'spiffe://prod.example/agent/analyst', stale: true, excessiveTrust: true } },
    ],
    relationships: [
      { sourceType: 'AI_APPLICATION', sourceKey: 'ai-app:finance', targetType: 'AI_AGENT', targetKey: 'agent:analyst', type: 'USES', evidence: { source: 'deployment manifest' } },
      { sourceType: 'AI_AGENT', sourceKey: 'agent:analyst', targetType: 'MCP_SERVER', targetKey: 'mcp:unknown', type: 'CONNECTS_TO', evidence: { source: 'agent config' } },
      { sourceType: 'MCP_SERVER', sourceKey: 'mcp:unknown', targetType: 'MCP_TOOL', targetKey: 'tool:shell', type: 'EXPOSES_TOOL', evidence: { source: 'tools/list' } },
    ],
  };
}

describe('AI-native posture intelligence', () => {
  it('discovers inventory and emits only rules supported by supplied facts', () => {
    const result = analyzePostureSnapshot(aiSnapshot());
    const ids = result.findings.map((finding) => finding.ruleId);
    expect(ids).toEqual(expect.arrayContaining([
      'BCI-AI-PROMPT-INJECTION', 'BCI-AI-EXCESSIVE-AGENCY', 'BCI-AI-TOOL-PRIVILEGE',
      'BCI-MCP-SHADOW-SERVER', 'BCI-MCP-TOOL-POISONING', 'BCI-MCP-COMMAND-INJECTION',
      'BCI-MCP-TOKEN-BOUNDARY', 'BCI-WORKLOAD-IDENTITY-INVALID', 'BCI-WORKLOAD-IDENTITY-TRUST',
    ]));
    expect(result.relationships).toHaveLength(3);
    expect(result.findings.every((finding) => finding.evidence.observed.standardMappings?.length > 0)).toBe(true);
  });

  it('does not infer prompt injection or tool poisoning from inventory alone', () => {
    const result = analyzePostureSnapshot({
      schemaVersion: '1.1', source: 'inventory', collectedAt: '2026-09-09T08:00:00.000Z',
      entities: [{ type: 'MCP_TOOL', key: 'tool:read', attributes: { name: 'read' } }],
    });
    expect(result.findings).toEqual([]);
  });

  it('does not accept an AI prediction as finding evidence', () => {
    const result = analyzePostureSnapshot({
      schemaVersion: '1.1', source: 'model-output', collectedAt: '2026-09-09T08:00:00.000Z',
      entities: [{ type: 'AI_APPLICATION', key: 'ai-app:predicted', attributes: { evidenceKind: 'AI_PREDICTION', untrustedInputReachable: true, promptBoundaryEnforced: false } }],
    });
    expect(result.findings).toEqual([]);
  });

  it('uses the official versioned ATLAS catalog IDs for exact rules', () => {
    expect(mapRuleToTechnique('BCI-AI-PROMPT-INJECTION')).toMatchObject({ framework: 'ATLAS', catalogVersion: '2026.08', techniqueId: 'AML.T0051' });
    expect(mapRuleToTechnique('BCI-MCP-TOOL-POISONING')).toMatchObject({ framework: 'ATLAS', techniqueId: 'AML.T0110' });
    expect(mapRuleToTechnique('BCI-AI-EXCESSIVE-AGENCY')).toBeNull();
  });
});

describe('Risk Model V3 and AI decision integration', () => {
  it('is backward-compatible at zero AI inputs and explainably raises evidence-backed AI risk', () => {
    const v2Compatible = computeRiskScore({ cvssScore: 6, confidenceScore: 80, internetExposure: 1 });
    const aiContext = computeRiskScore({
      cvssScore: 6, confidenceScore: 80, internetExposure: 1,
      agentPrivilege: 1, autonomousActionCapability: 1, toolPrivilege: 1,
      mcpExposure: 1, promptInjectionReachability: 1, sensitiveDataReachability: 1,
      workloadIdentityPrivilege: 1,
    });
    expect(RISK_MODEL_VERSION).toBe(3);
    expect(aiContext.score).toBeGreaterThan(v2Compatible.score);
    expect(aiContext.breakdown).toMatchObject({
      agentPrivilege: 1, autonomousActionCapability: 1, toolPrivilege: 1,
      mcpExposure: 1, promptInjectionReachability: 1, sensitiveDataReachability: 1,
      workloadIdentityPrivilege: 1,
      evidencePolicy: 'persisted-observation-only; AI predictions are not evidence',
    });
  });

  it('simulates an MCP tool boundary on the isolated digital twin only', () => {
    const result = simulateDigitalTwin({
      graphSnapshotHash: 'snapshot',
      findings: [{ id: 'f1', target: 'tool:shell', category: 'MCP_SECURITY', status: 'NEW', risk_score: 80 }],
      relationships: [{ id: 'edge1', sourceKey: 'agent:a', targetKey: 'tool:shell', type: 'CAN_INVOKE' }],
    }, { type: 'DISABLE_MCP_TOOL', entityKey: 'tool:shell' });
    expect(result.estimatedRiskAfter).toBe(24);
    expect(result.closedAttackPathEdges).toEqual(['edge1']);
  });
});

describe('CycloneDX AI/ML-BOM', () => {
  it('ingests model, dataset, framework, provider, and provenance relationships', () => {
    const facts = normalizeSbomDocument('CYCLONEDX', {
      bomFormat: 'CycloneDX', specVersion: '1.7',
      components: [
        { type: 'machine-learning-model', 'bom-ref': 'model:m1', name: 'm1', version: '1', modelCard: { properties: [{ name: 'cdx:ai-ml:model:parameter:count', value: '7B' }] } },
        { type: 'data', 'bom-ref': 'dataset:d1', name: 'd1' },
        { type: 'library', 'bom-ref': 'framework:f1', name: 'f1', properties: [{ name: 'bci:entityType', value: 'AI_FRAMEWORK' }] },
      ],
      services: [{ 'bom-ref': 'provider:p1', name: 'provider' }],
      dependencies: [{ ref: 'model:m1', dependsOn: ['dataset:d1', 'framework:f1', 'provider:p1'] }],
    });
    expect(facts.entities.map((entity) => entity.type)).toEqual(expect.arrayContaining(['MODEL', 'DATASET', 'AI_FRAMEWORK', 'MODEL_PROVIDER']));
    expect(facts.relationships).toHaveLength(3);
    expect(exportCycloneDx(facts.entities, facts.relationships)).toMatchObject({ bomFormat: 'CycloneDX', specVersion: '1.7' });
  });
});
