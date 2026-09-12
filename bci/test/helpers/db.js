import { query } from '../../src/db/client.js';

// Truncate every tenant-data table between tests -- CASCADE handles FK
// order so tests never need to know the dependency graph. schema_migrations
// and the RBAC catalog (roles/permissions/role_permissions) are seed/system
// data, not per-test data, so they're left alone.
export async function resetDatabase() {
  await query(`
    TRUNCATE TABLE
      crypto_findings,
      quantum_jobs,
      quantum_benchmarks,
      quantum_policies,
      scan_job_engine_runs,
      reports,
      verification_runs,
      remediations,
      security_graph_edges,
      security_graph_nodes,
      risk_history,
      intelligence_updates,
      vulnerabilities,
      finding_sources,
      findings,
      normalized_observations,
      raw_observations,
      job_workers,
      scan_jobs,
      audit_events,
      scope_exclusions,
      authorized_scopes,
      scan_policies,
      asset_relationships,
      asset_technologies,
      asset_identifiers,
      assets,
      user_roles,
      users,
      organizations
    RESTART IDENTITY CASCADE
  `);
}

export async function createOrg(name = 'Test Org', slug = 'test-org') {
  const { rows } = await query(
    'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
    [name, slug]
  );
  return rows[0].id;
}

export async function createUser(orgId, { email = 'user@example.com', passwordHash, roleId = 'viewer' } = {}) {
  const { hashPassword } = await import('../../src/lib/password.js');
  const hash = passwordHash || (await hashPassword('correct horse battery staple'));
  const { rows } = await query(
    'INSERT INTO users (org_id, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
    [orgId, email, hash]
  );
  const userId = rows[0].id;
  if (roleId) {
    await query('INSERT INTO user_roles (user_id, org_id, role_id) VALUES ($1, $2, $3)', [userId, orgId, roleId]);
  }
  return userId;
}

export async function seedEngine(id, { intrusiveness = 'PASSIVE', license = 'MIT' } = {}) {
  await query(
    `INSERT INTO engine_registry (id, name, intrusiveness, license) VALUES ($1, $1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [id, intrusiveness, license]
  );
}

export async function insertNormalizedObservation(orgId, jobId, overrides = {}) {
  const engineId = overrides.engineId || 'semgrep';
  await seedEngine(engineId);

  const raw = await query(
    `INSERT INTO raw_observations (org_id, job_id, engine_id, target, payload)
     VALUES ($1, $2, $3, $4, '{}') RETURNING id`,
    [orgId, jobId, engineId, overrides.target || 'example.com']
  );

  const { rows } = await query(
    `INSERT INTO normalized_observations (
       org_id, raw_observation_id, job_id, engine_id, rule_id, target, category, title,
       cve_ids, cwe_ids, component, component_version, location, capability_id, evidence
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [
      orgId,
      raw.rows[0].id,
      jobId,
      engineId,
      overrides.ruleId || null,
      overrides.target || 'example.com',
      overrides.category || 'SAST',
      overrides.title || 'Test finding',
      overrides.cveIds || [],
      overrides.cweIds || [],
      overrides.component || null,
      overrides.componentVersion || null,
      overrides.location || 'example.com',
      overrides.capabilityId || null,
      JSON.stringify(overrides.evidence || {}),
    ]
  );
  return rows[0];
}
