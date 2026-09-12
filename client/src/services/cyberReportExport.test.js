import { describe, expect, it } from 'vitest';
import { buildBciReportExport, buildControlledProofExportReport, buildFindingExportReport, buildScanExportReport, controlledProofRejectionExplanation } from './cyberReportExport.js';
import { t } from './i18n.js';

describe('BCI export report models', () => {
  it('builds a scan report from real displayed result fields', () => {
    const report = buildScanExportReport({ job: { id: 'scan-1', target: 'example.com', requested_class: 'PASSIVE', status: 'COMPLETED' }, engineRuns: [{ engine_id: 'native-http', status: 'COMPLETED', observation_count: 2 }], findings: [{ title: 'Finding', priority: 'HIGH', risk_score: 70, status: 'NEW' }] });
    expect(report.content).toContain('example.com');
    expect(report.content).toContain('native-http');
    expect(report.filename).toBe('BCI_SCAN_scan-1');
  });

  it('builds finding and controlled-proof reports without exporting secrets', () => {
    const finding = buildFindingExportReport({ finding: { id: 'f1', title: 'Test', target: 'example.com', verification_status: 'VERIFIED' }, sources: [{ engine_id: 'nuclei', rule_id: 'rule-1' }] });
    expect(finding.content).toContain('nuclei');
    const proof = buildControlledProofExportReport({
      proofId: 'ABC', normalizedTarget: 'https://example.com/', securityImpact: 'VERIFIED_IMPACT_PATH',
      securityEvidence: {
        evidenceEngineCoverage: { naabu: { observations: 40, candidates: 0, rejected: 40 }, nuclei: { observations: 33, candidates: 0, rejected: 33 } },
        candidateRejections: [
          { engineId: 'naabu', reason: 'NOT_WEB_CONTENT_IMPACT_SIGNAL' },
          { engineId: 'naabu', reason: 'NOT_WEB_CONTENT_IMPACT_SIGNAL' },
        ],
        candidateRejectionSummary: [{ engineId: 'naabu', reason: 'NOT_WEB_CONTENT_IMPACT_SIGNAL', count: 40 }],
        liveEngineExecutions: [{ engineId: 'nuclei', status: 'COMPLETED', observations: 3 }],
        securityObservations: [{ engineId: 'intrusive-validation', ruleId: 'BCI-INTRUSIVE-CORS_VALIDATION', title: 'CORS reflects an untrusted Origin', category: 'ACTIVE_VALIDATION', severity: 'HIGH', location: 'https://example.com/api', verificationStatus: 'CONFIRMED', proofEligibility: 'NOT_WEB_CONTENT_IMPACT_SIGNAL', evidenceHash: 'd'.repeat(64), technicalEvidence: 'Origin was reflected.', possibleImpact: 'Cross-origin data exposure.', technology: 'Microsoft IIS', remediation: 'Restrict allowed origins.', revalidation: 'Repeat the origin check.' }],
        deliveryProviderDiscovery: {
          candidates: [{ providerId: 'cloudflare', providerLabel: 'Cloudflare', confidence: 'HIGH', adapterStatus: 'IMPLEMENTED' }],
          supportMatrix: [
            { id: 'cloudflare', label: 'Cloudflare', adapterId: 'cloudflare-edge-worker', adapterStatus: 'IMPLEMENTED' },
            { id: 'microsoft-iis', label: 'Microsoft IIS', adapterStatus: 'BLOCKED', blockingReason: 'origin_change_has_no_safe_self_expiry' },
          ],
        },
      },
      publicProofStatus: 'UNAVAILABLE',
    });
    expect(proof.content).toContain('VERIFIED_IMPACT_PATH');
    expect(proof.content).toContain('cloudflare');
    expect(proof.content).toContain('Public Visibility Support Matrix');
    expect(proof.content).toContain('Microsoft IIS');
    expect(proof.content).toContain('origin_change_has_no_safe_self_expiry');
    expect(proof.content).toContain('Engine: naabu ; Evidence: 40 ; Proof Candidates: 0 ; Rejected: 40');
    expect(proof.content).toContain('Reason Code: NOT_WEB_CONTENT_IMPACT_SIGNAL ; Count: 40 ; Explanation:');
    expect(proof.content).toContain('Live Engine Execution');
    expect(proof.content).toContain('Status: COMPLETED');
    expect(proof.content).toContain('CORS reflects an untrusted Origin');
    expect(proof.content).toContain('BCI-INTRUSIVE-CORS_VALIDATION');
    expect(proof.content).toContain('Finding Evidence');
    expect(proof.content).toContain('Origin was reflected.');
    expect(proof.content).toContain('Restrict allowed origins.');
    expect(proof.content).not.toContain('Persistent Modification');
    expect(proof.content).toContain('Public Visibility: UNAVAILABLE');
    expect(proof.content).not.toContain('| ---');
    expect(proof.content).not.toMatch(/^# /);
    expect(proof.content).not.toContain('undefined');
  });

  it('translates controlled-proof values and rejection explanations without losing reason codes', () => {
    const dictionary = {
      cyberControlledProofSecurityImpact: 'Güvenlik Etkisi', cyberColStatus: 'Durum', cyberControlledProofVerifiedPath: 'DOĞRULANMIŞ ETKİ YOLU',
      cyberControlledProofRejectNotContentImpact: 'Açıklanmış eleme nedeni', cyberControlledProofStatusUnavailable: 'KULLANILAMIYOR',
    };
    const translate = (key) => dictionary[key] || key;
    const report = buildControlledProofExportReport({ proofId: 'TR1', securityImpact: 'VERIFIED_IMPACT_PATH', publicProofStatus: 'UNAVAILABLE', securityEvidence: { candidateRejections: [{ engineId: 'nuclei', reason: 'NOT_WEB_CONTENT_IMPACT_SIGNAL' }] } }, { translate });
    expect(report.content).toContain('## Güvenlik Etkisi');
    expect(report.content).toContain('DOĞRULANMIŞ ETKİ YOLU');
    expect(report.content).toContain('KULLANILAMIYOR');
    expect(report.content).toContain('NOT_WEB_CONTENT_IMPACT_SIGNAL');
    expect(report.content).toContain('Açıklanmış eleme nedeni');
    expect(controlledProofRejectionExplanation('NOT_WEB_CONTENT_IMPACT_SIGNAL', translate)).toBe('Açıklanmış eleme nedeni');
  });

  it('renders the complete controlled-proof export in every supported UI language', () => {
    for (const lang of ['tr', 'en', 'de', 'fr', 'ar']) {
      const report = buildControlledProofExportReport({
        proofId: lang.toUpperCase(), securityImpact: 'NO_PATH', publicProofStatus: 'UNAVAILABLE',
        securityEvidence: {
          evidenceEngineCoverage: { nuclei: { observations: 3, candidates: 0, rejected: 3 } },
          candidateRejections: [{ engineId: 'nuclei', reason: 'NOT_WEB_CONTENT_IMPACT_SIGNAL' }],
        },
      }, { translate: (key) => t(lang, key) });
      expect(report.content).not.toContain('cyberControlledProof');
      expect(report.content).toContain('NOT_WEB_CONTENT_IMPACT_SIGNAL');
      expect(report.content).toContain(t(lang, 'cyberControlledProofPublicTitle'));
      expect(report.content).toContain(t(lang, 'cyberControlledProofRejectNotContentImpact'));
      expect(report.title).toContain(t(lang, 'cyberControlledProofTitle'));
    }
  });

  it('localizes scan and generated BCI reports in every supported UI language', () => {
    for (const lang of ['tr', 'en', 'de', 'fr', 'ar']) {
      const options = { translate: (key) => t(lang, key), locale: lang };
      const scan = buildScanExportReport({
        job: { id: 'scan-i18n', target: 'example.com', requested_class: 'PASSIVE', status: 'COMPLETED', created_at: '2026-09-11T10:00:00Z' },
        engineRuns: [{ engine_id: 'native-http', status: 'COMPLETED', observation_count: 2 }],
        findings: [{ title: 'Technical finding', priority: 'HIGH_PRIORITY', risk_score: 70, status: 'NEW' }],
      }, options);
      const generated = buildBciReportExport({
        id: 'report-i18n', report_type: 'TECHNICAL', integrityValid: true, created_at: '2026-09-11T10:00:00Z',
        content: { findingCount: 1, findings: [{ priority: 'HIGH_PRIORITY', status: 'NEW' }] },
      }, options);

      expect(scan.title).toContain(t(lang, 'cyberScanExportTitle'));
      expect(scan.content).toContain(t(lang, 'cyberReportFieldScanId'));
      expect(scan.content).toContain(t(lang, 'cyberValueCompleted'));
      expect(scan.content).toContain(t(lang, 'cyberValueHighPriority'));
      expect(generated.title).toContain(t(lang, 'cyberBciReportTitle'));
      expect(generated.content).toContain(t(lang, 'cyberReportContentTitle'));
      expect(generated.content).toContain(t(lang, 'cyberFindingCount'));
      expect(`${scan.content}\n${generated.content}`).not.toMatch(/cyber(?:Value|Report|Scan|Col)/);
    }
  });

  it('redacts sensitive keys from generated BCI reports', () => {
    const report = buildBciReportExport({ id: 'r1', report_type: 'TECHNICAL', integrityValid: true, content: { summary: 'safe', apiToken: 'must-not-leak', nested: { cookie: 'secret-cookie' } } });
    expect(report.content).toContain('safe');
    expect(report.content).toContain('[REDACTED]');
    expect(report.content).not.toContain('must-not-leak');
    expect(report.content).not.toContain('secret-cookie');
  });
});
