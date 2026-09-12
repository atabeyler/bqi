import { describe, expect, it } from 'vitest';
import { analyzePostureSnapshot, postureSnapshotSchema } from '../src/engines/adapters/postureIntelligence.js';
import { normalizeRaw } from '../src/normalization/normalize.js';

function snapshot() {
  return {
    schemaVersion: '1.0',
    source: 'aws-security-hub-export',
    collectedAt: '2026-09-09T06:00:00.000Z',
    entities: [
      { type: 'CLOUD_STORAGE', key: 'arn:aws:s3:::public-data', attributes: { public: true, encrypted: false, accessToken: 'must-not-persist' } },
      { type: 'IDENTITY', key: 'arn:aws:iam::123:user/admin', attributes: { permissions: ['*'], interactive: true, mfa: false } },
      { type: 'DATABASE', key: 'arn:aws:rds:eu-west-1:123:db:prod', attributes: { internetExposed: true, encrypted: false } },
    ],
    relationships: [
      { sourceType: 'IDENTITY', sourceKey: 'arn:aws:iam::123:user/admin', targetType: 'DATABASE', targetKey: 'arn:aws:rds:eu-west-1:123:db:prod', type: 'CAN_ACCESS', evidence: { authorization: 'Bearer secret' } },
    ],
    controls: [
      { key: 'mfa', type: 'MFA', status: 'PARTIAL', effectiveness: 0.5, evidence: { password: 'secret' }, protects: [] },
    ],
  };
}

describe('posture intelligence adapter', () => {
  it('accepts the versioned bounded snapshot contract', () => {
    expect(postureSnapshotSchema.parse(snapshot()).schemaVersion).toBe('1.0');
  });

  it('derives findings only from supplied facts and preserves provenance', () => {
    const result = analyzePostureSnapshot(snapshot());
    expect(result.findings.map((finding) => finding.ruleId)).toEqual(expect.arrayContaining([
      'BCI-CLOUD-PUBLIC', 'BCI-CLOUD-ENCRYPTION', 'BCI-IAM-EXCESSIVE', 'BCI-IAM-MFA', 'BCI-DATABASE-EXPOSURE', 'BCI-DATABASE-POSTURE',
    ]));
    expect(result.source).toBe('aws-security-hub-export');
    expect(result.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.findings.every((finding) => finding.cveIds.length === 0)).toBe(true);
  });

  it('redacts sensitive snapshot values before downstream storage', () => {
    const result = analyzePostureSnapshot(snapshot());
    expect(result.entities[0].attributes.accessToken).toBe('[REDACTED]');
    expect(result.relationships[0].evidence.authorization).toBe('[REDACTED]');
    expect(result.controls[0].evidence.password).toBe('[REDACTED]');
  });

  it('normalizes the unified findings into the existing pipeline contract', () => {
    const result = analyzePostureSnapshot(snapshot());
    const normalized = normalizeRaw('bci-posture-intelligence', result);
    expect(normalized).toHaveLength(result.findings.length);
    expect(normalized[0]).toMatchObject({ capabilityId: expect.any(String), category: expect.any(String), evidence: expect.any(Object) });
  });

  it('rejects unversioned or unbounded input instead of guessing', () => {
    expect(() => analyzePostureSnapshot({ ...snapshot(), schemaVersion: '2.0' })).toThrow();
    expect(() => analyzePostureSnapshot({ ...snapshot(), entities: Array.from({ length: 5_001 }, (_, index) => ({ type: 'HOST', key: String(index), attributes: {} })) })).toThrow();
  });

  it('accepts embedded CycloneDX and derives the package graph', () => {
    const result = analyzePostureSnapshot({
      schemaVersion: '1.0', source: 'build-pipeline', collectedAt: '2026-09-09T06:00:00.000Z',
      sboms: [{ format: 'CYCLONEDX', document: {
        bomFormat: 'CycloneDX', components: [
          { type: 'application', 'bom-ref': 'app', name: 'app' },
          { type: 'library', 'bom-ref': 'lib', name: 'lib' },
        ], dependencies: [{ ref: 'app', dependsOn: ['lib'] }],
      } }],
    });
    expect(result.entities).toHaveLength(2);
    expect(result.relationships[0]).toMatchObject({ sourceKey: 'app', targetKey: 'lib', type: 'DEPENDS_ON' });
  });
});
