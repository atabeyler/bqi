import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db/client.js';
import { resetDatabase, createOrg, createUser, insertNormalizedObservation } from './helpers/db.js';
import { correlateJobObservations } from '../src/services/correlation.js';
import { explainFinding, verifyExploitationClaim } from '../src/services/decisionSupport.js';
import { upsertVulnerability } from '../src/services/intelligence.js';
import { getActiveProvider } from '../src/ai/registry.js';

beforeEach(resetDatabase);

describe('AI provider registry', () => {
  it('defaults to the disabled provider when BCI_AI_MODE is unset/AI_DISABLED', () => {
    expect(getActiveProvider().id).toBe('disabled');
  });
});

describe('explainFinding (always returns something, AI or not)', () => {
  it('falls back to a deterministic summary when AI is disabled', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    const jobId = (await query(`INSERT INTO scan_jobs (org_id, requested_by, target, requested_class) VALUES ($1,$2,'t1','PASSIVE') RETURNING id`, [orgId, userId])).rows[0].id;
    await insertNormalizedObservation(orgId, jobId, { engineId: 'semgrep', ruleId: 'eval-detected', location: 'app.js:7', target: 't1' });
    const [findingId] = await correlateJobObservations(orgId, jobId);
    const { rows } = await query('SELECT * FROM findings WHERE id = $1', [findingId]);

    const outcome = await explainFinding(orgId, userId, rows[0]);
    expect(outcome.source).toBe('deterministic');
    expect(outcome.text).toContain(rows[0].title);

    const { rows: audit } = await query("SELECT * FROM audit_events WHERE action = 'ai.explain_finding' AND org_id = $1", [orgId]);
    expect(audit).toHaveLength(1);
    expect(audit[0].result).toBe('FAILURE'); // provider unavailable is a recorded fact, not swallowed silently
  });
});

describe('verifyExploitationClaim (spec section 42: AI comments, evidence confirms)', () => {
  it('confirms a claim only when the local KEV-backed knowledge base agrees', async () => {
    await upsertVulnerability({ cveId: 'CVE-2099-40001', kev: true });
    await upsertVulnerability({ cveId: 'CVE-2099-40002', kev: false });

    expect(await verifyExploitationClaim('CVE-2099-40001')).toMatchObject({ status: 'CONFIRMED' });
    expect(await verifyExploitationClaim('CVE-2099-40002')).toMatchObject({ status: 'UNVERIFIED' });
    expect(await verifyExploitationClaim('CVE-2099-99999')).toMatchObject({ status: 'UNVERIFIED' });
  });
});
