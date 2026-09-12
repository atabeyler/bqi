import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db/client.js';
import { resetDatabase, createOrg, createUser, insertNormalizedObservation } from './helpers/db.js';
import { correlateJobObservations } from '../src/services/correlation.js';
import { upsertVulnerability } from '../src/services/intelligence.js';
import { generateReport, getReport, listReports } from '../src/services/reports.js';

beforeEach(resetDatabase);

async function seedOrgWithOneKevFinding() {
  const orgId = await createOrg();
  const userId = await createUser(orgId, { roleId: 'operator' });
  const jobId = (await query(
    `INSERT INTO scan_jobs (
       org_id, requested_by, target, requested_class, recommended_capability_ids,
       selected_capability_ids, recommended_engine_ids, selected_engine_ids, result
     ) VALUES ($1,$2,'t1','PASSIVE',ARRAY['SAST','SCA'],ARRAY['SCA'],ARRAY['semgrep','trivy'],ARRAY['trivy'],
       '{"actualExecutedCapabilities":["SCA"],"enginesRun":["trivy"]}') RETURNING id`,
    [orgId, userId]
  )).rows[0].id;
  await upsertVulnerability({ cveId: 'CVE-2099-30001', cvssScore: 9.5, kev: true });
  await insertNormalizedObservation(orgId, jobId, { engineId: 'trivy', capabilityId: 'SCA', evidence: { package: 'example' }, cveIds: ['CVE-2099-30001'], target: 't1' });
  await correlateJobObservations(orgId, jobId);
  return { orgId, userId };
}

describe('EXECUTIVE report', () => {
  it('surfaces the KEV exposure and top risk', async () => {
    const { orgId, userId } = await seedOrgWithOneKevFinding();
    const report = await generateReport(orgId, userId, 'EXECUTIVE');

    expect(report.content.kevExposureCount).toBe(1);
    expect(report.content.criticalFindingCount).toBe(1);
    expect(report.content.topRisks).toHaveLength(1);
    expect(report.bci_version).toBeDefined();
    expect(report.model_versions.risk).toBeGreaterThanOrEqual(1);
  });
});

describe('TECHNICAL report', () => {
  it('includes the finding and its engine sources', async () => {
    const { orgId, userId } = await seedOrgWithOneKevFinding();
    const report = await generateReport(orgId, userId, 'TECHNICAL');
    expect(report.content.findingCount).toBe(1);
    expect(report.content.findings[0].sources[0].engine_id).toBe('trivy');
    expect(report.content.findings[0].sources[0]).toMatchObject({ capability_id: 'SCA', scan_job_id: expect.any(String), evidence: { package: 'example' } });
    expect(report.content.executionProvenance[0]).toMatchObject({
      recommended_capability_ids: ['SAST', 'SCA'], selected_capability_ids: ['SCA'],
      actual_executed_capabilities: ['SCA'], actual_executed_engines: ['trivy'],
    });
  });

  it('scopes findings and source evidence to one exact analysis job', async () => {
    const { orgId, userId } = await seedOrgWithOneKevFinding();
    const firstJob = (await query('SELECT id FROM scan_jobs WHERE org_id = $1 ORDER BY created_at LIMIT 1', [orgId])).rows[0].id;
    const secondJob = (await query(
      `INSERT INTO scan_jobs (org_id, requested_by, target, requested_class) VALUES ($1,$2,'other-target','PASSIVE') RETURNING id`,
      [orgId, userId]
    )).rows[0].id;
    await insertNormalizedObservation(orgId, secondJob, { engineId: 'semgrep', capabilityId: 'SAST', evidence: { rule: 'other' }, target: 'other-target' });
    await correlateJobObservations(orgId, secondJob);

    const report = await generateReport(orgId, userId, 'TECHNICAL', { scanJobId: firstJob });
    expect(report.scan_job_id).toBe(firstJob);
    expect(report.content.scopedToScanJobId).toBe(firstJob);
    expect(report.content.findingCount).toBe(1);
    expect(report.content.findings[0].sources).toHaveLength(1);
    expect(report.content.findings[0].sources[0].scan_job_id).toBe(firstJob);
    expect(report.content.executionProvenance).toHaveLength(1);
    expect(report.content.executionProvenance[0].scan_job_id).toBe(firstJob);
  });
});

describe('report integrity', () => {
  it('detects tampering: a directly-edited content column fails integrity on read', async () => {
    const { orgId, userId } = await seedOrgWithOneKevFinding();
    const created = await generateReport(orgId, userId, 'EXECUTIVE');

    const untampered = await getReport(orgId, created.id);
    expect(untampered.integrityValid).toBe(true);

    await query("UPDATE reports SET content = content || '{\"criticalFindingCount\": 999}'::jsonb WHERE id = $1", [created.id]);
    const tampered = await getReport(orgId, created.id);
    expect(tampered.integrityValid).toBe(false);
  });

  it('lists reports without exposing the full content', async () => {
    const { orgId, userId } = await seedOrgWithOneKevFinding();
    await generateReport(orgId, userId, 'EXECUTIVE');
    await generateReport(orgId, userId, 'AUDIT');

    const list = await listReports(orgId);
    expect(list).toHaveLength(2);
    expect(list[0].content).toBeUndefined();
  });
});

describe('asset-scoped reports (real identifier matching, no fabricated per-asset score)', () => {
  it('scopes EXECUTIVE finding counts to one asset while leaving securityScore/coverageScore org-wide and labeled as such', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });

    // Asset A's target has the KEV finding; a second, unrelated target
    // (no asset) also has an open finding that must not count toward A.
    const jobA = (await query(`INSERT INTO scan_jobs (org_id, requested_by, target, requested_class) VALUES ($1,$2,'a.example','PASSIVE') RETURNING id`, [orgId, userId])).rows[0].id;
    await upsertVulnerability({ cveId: 'CVE-2099-30002', cvssScore: 9.1, kev: true });
    await insertNormalizedObservation(orgId, jobA, { engineId: 'trivy', cveIds: ['CVE-2099-30002'], target: 'a.example' });
    await correlateJobObservations(orgId, jobA);
    await query(
      `INSERT INTO findings (org_id, correlation_key, category, title, target, status, priority, risk_score)
       VALUES ($1, 'other-key', 'WEB', 'unrelated', 'b.example', 'NEW', 'IMMEDIATE', 95)`,
      [orgId]
    );

    const assetRes = await query(
      `INSERT INTO assets (org_id, name, asset_type, created_by) VALUES ($1, 'Asset A', 'DOMAIN', $2) RETURNING id`,
      [orgId, userId]
    );
    const assetId = assetRes.rows[0].id;
    await query(`INSERT INTO asset_identifiers (asset_id, identifier_type, value) VALUES ($1, 'DOMAIN', 'a.example')`, [assetId]);

    const report = await generateReport(orgId, userId, 'EXECUTIVE', { assetId });
    expect(report.asset_id).toBe(assetId);
    expect(report.content.scopedToTargets).toEqual(['a.example']);
    expect(report.content.criticalFindingCount).toBe(1); // only a.example's finding
    expect(report.content.securityCoverageScoreScope).toBe('ORG_WIDE');
  });

  it('never leaks another org\'s asset identifiers into a scoped report', async () => {
    const orgA = await createOrg('A', 'org-a');
    const orgB = await createOrg('B', 'org-b');
    const userA = await createUser(orgA, { email: 'a@test.local', roleId: 'operator' });
    const bAssetRes = await query(`INSERT INTO assets (org_id, name, asset_type, created_by) VALUES ($1,'b-asset','DOMAIN',$2) RETURNING id`, [orgB, await createUser(orgB, { email: 'b@test.local', roleId: 'operator' })]);
    await query(`INSERT INTO asset_identifiers (asset_id, identifier_type, value) VALUES ($1,'DOMAIN','b-secret.example')`, [bAssetRes.rows[0].id]);

    const report = await generateReport(orgA, userA, 'EXECUTIVE', { assetId: bAssetRes.rows[0].id });
    // Org B's asset resolves to zero targets from org A's perspective --
    // the report is scoped to nothing, never silently falls back to org-wide.
    expect(report.content.scopedToTargets).toEqual([]);
  });

  it('listReports filters by assetId', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    const assetRes = await query(`INSERT INTO assets (org_id, name, asset_type, created_by) VALUES ($1,'x','DOMAIN',$2) RETURNING id`, [orgId, userId]);
    const assetId = assetRes.rows[0].id;

    await generateReport(orgId, userId, 'AUDIT'); // unscoped
    await generateReport(orgId, userId, 'EXECUTIVE', { assetId });

    const scoped = await listReports(orgId, { assetId });
    expect(scoped).toHaveLength(1);
    expect(scoped[0].asset_id).toBe(assetId);
  });
});

describe('FULL report', () => {
  it('bundles all four report builders without disturbing their independent generation', async () => {
    const { orgId, userId } = await seedOrgWithOneKevFinding();
    await generateReport(orgId, userId, 'EXECUTIVE'); // seeds a report.generate audit event for FULL's own audit builder to read
    const full = await generateReport(orgId, userId, 'FULL');
    expect(full.content.executive.kevExposureCount).toBe(1);
    expect(full.content.technical.findingCount).toBe(1);
    expect(full.content.remediation.items.length).toBeGreaterThan(0);
    expect(full.content.audit.eventCount).toBeGreaterThan(0);
    expect(full.content.sectionScopes.audit).toBe('ORG_WIDE');

    // The standalone types still work exactly as before.
    const standaloneExec = await generateReport(orgId, userId, 'EXECUTIVE');
    expect(standaloneExec.content.kevExposureCount).toBe(1);
  });
});

describe('AUDIT report', () => {
  it('is itself built from the audit ledger', async () => {
    const { orgId, userId } = await seedOrgWithOneKevFinding();
    await generateReport(orgId, userId, 'EXECUTIVE'); // generates a report.generate audit event to read back
    const report = await generateReport(orgId, userId, 'AUDIT');
    expect(report.content.eventCount).toBeGreaterThan(0);
    expect(report.content.events.some((e) => e.action === 'report.generate')).toBe(true);
  });
});
