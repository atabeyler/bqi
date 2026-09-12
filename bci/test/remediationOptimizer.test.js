import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db/client.js';
import { resetDatabase, createOrg, createUser, insertNormalizedObservation } from './helpers/db.js';
import { correlateJobObservations } from '../src/services/correlation.js';
import { upsertVulnerability } from '../src/services/intelligence.js';
import { optimizeRemediation, buildRemediationProblem } from '../src/services/remediationOptimizer.js';

beforeEach(resetDatabase);

async function seedFinding(orgId, userId, cveId, cvssScore, category = 'SCA', target = `t-${cveId}`) {
  const jobId = (await query(`INSERT INTO scan_jobs (org_id, requested_by, target, requested_class) VALUES ($1,$2,$3,'PASSIVE') RETURNING id`, [orgId, userId, target])).rows[0].id;
  await upsertVulnerability({ cveId, cvssScore });
  await insertNormalizedObservation(orgId, jobId, { engineId: 'trivy', category, cveIds: [cveId], target });
  return correlateJobObservations(orgId, jobId);
}

describe('buildRemediationProblem (integration)', () => {
  it('turns open, risk-scored findings into knapsack items with category-based effort costs', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    await seedFinding(orgId, userId, 'CVE-2099-70001', 9.0, 'SCA');
    await seedFinding(orgId, userId, 'CVE-2099-70002', 3.0, 'WEB');

    const items = await buildRemediationProblem(orgId);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.cost >= 1)).toBe(true);
    expect(items.every((i) => i.value > 0)).toBe(true);
  });

  it('excludes closed findings (they need no remediation)', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    const [findingId] = await seedFinding(orgId, userId, 'CVE-2099-70003', 9.0);
    await query("UPDATE findings SET status = 'VERIFIED_FIXED' WHERE id = $1", [findingId]);

    expect(await buildRemediationProblem(orgId)).toEqual([]);
  });
});

describe('optimizeRemediation (integration, real benchmark)', () => {
  it('proposes a feasible selection under the effort budget with an expected risk reduction', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    await seedFinding(orgId, userId, 'CVE-2099-70010', 9.5, 'SCA');
    await seedFinding(orgId, userId, 'CVE-2099-70011', 8.0, 'WEB');
    await seedFinding(orgId, userId, 'CVE-2099-70012', 2.0, 'SCA');

    const result = await optimizeRemediation({ orgId, actorUserId: userId, effortBudget: 2 });

    expect(result.benchmarkId).toBeDefined();
    expect(result.optimizationObjective).toBeGreaterThan(0);
    expect(result.selection.length).toBeGreaterThan(0);
    expect(['QUANTUM_BENEFIT_OBSERVED_FOR_THIS_WORKLOAD', 'NO_QUANTUM_ADVANTAGE_DEMONSTRATED']).toContain(result.verdict);
  });

  it('reports honestly when there is nothing to optimize -- a distinct NOT_APPLICABLE verdict, no benchmark row written', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    const result = await optimizeRemediation({ orgId, actorUserId: userId, effortBudget: 5 });
    expect(result.selectedFindingIds).toEqual([]);
    expect(result.note).toMatch(/no open findings/);
    expect(result.verdict).toBe('NOT_APPLICABLE');
    expect(result.benchmarkId).toBeNull();
  });

  it('preserves recommended/selected provenance but no actual mode when a scan has nothing to optimize', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    const { rows } = await query(
      `INSERT INTO scan_jobs (org_id, requested_by, target, requested_class, recommended_compute_mode, selected_compute_mode)
       VALUES ($1,$2,'example.com','SAFE_ACTIVE','QUANTUM_INSPIRED','QUANTUM_INSPIRED') RETURNING id`,
      [orgId, userId]
    );
    const result = await optimizeRemediation({
      orgId, actorUserId: userId, effortBudget: 5, findingIds: [],
      preferredMode: 'QUANTUM_INSPIRED', scanJobId: rows[0].id,
    });
    expect(result).toMatchObject({
      verdict: 'NOT_APPLICABLE',
      recommendedMode: 'QUANTUM_INSPIRED',
      selectedMode: 'QUANTUM_INSPIRED',
      actualMode: null,
      fallbackReason: null,
    });
  });

  it('scopes the optimization to one scan job\'s findings when findingIds is given -- a finding outside it never counts', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    const [scopedFindingId] = await seedFinding(orgId, userId, 'CVE-2099-70020', 9.0, 'SCA');
    await seedFinding(orgId, userId, 'CVE-2099-70021', 9.9, 'SCA'); // higher risk, but out of scope

    const items = await buildRemediationProblem(orgId, { findingIds: [scopedFindingId] });
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(scopedFindingId);

    const result = await optimizeRemediation({ orgId, actorUserId: userId, effortBudget: 5, findingIds: [scopedFindingId] });
    expect(result.verdict).not.toBe('NOT_APPLICABLE');
    expect(result.selectedFindingIds.every((id) => id === scopedFindingId)).toBe(true);
  });

  it('records real recommended/selected/actual compute-mode provenance, with no fallback when nothing diverged', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    await seedFinding(orgId, userId, 'CVE-2099-70030', 8.0, 'SCA');

    // No preferredMode given -- the pre-existing call shape.
    const noPref = await optimizeRemediation({ orgId, actorUserId: userId, effortBudget: 3 });
    expect(noPref.selectedMode).toBeNull();
    expect(noPref.fallbackReason).toBeNull();
    expect(noPref.actualMode).toBe(noPref.recommendedMode);

    // Explicit CLASSICAL preference always succeeds (always available) --
    // selected and actual must match, so no fallback is recorded.
    const withPref = await optimizeRemediation({ orgId, actorUserId: userId, effortBudget: 3, preferredMode: 'CLASSICAL' });
    expect(withPref.selectedMode).toBe('CLASSICAL');
    expect(withPref.actualMode).toBe('CLASSICAL');
    expect(withPref.fallbackReason).toBeNull();

    const { rows } = await query('SELECT recommended_mode, selected_mode, actual_mode FROM quantum_benchmarks WHERE id = $1', [withPref.benchmarkId]);
    expect(rows[0].selected_mode).toBe('CLASSICAL');
    expect(rows[0].actual_mode).toBe('CLASSICAL');
  });

  it('records a real fallback reason when the preferred mode could not actually be used', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    await seedFinding(orgId, userId, 'CVE-2099-70031', 8.0, 'SCA');
    // Org policy denies quantum by default -- preferring hardware must
    // still fall all the way back to CLASSICAL, with the real reason.
    const result = await optimizeRemediation({ orgId, actorUserId: userId, effortBudget: 3, preferredMode: 'QUANTUM_HARDWARE' });
    expect(result.selectedMode).toBe('QUANTUM_HARDWARE');
    expect(result.actualMode).toBe('CLASSICAL');
    expect(result.fallbackReason).toBe('org_policy_denies_quantum');
  });
});
