import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db/client.js';
import { resetDatabase, createOrg } from './helpers/db.js';
import { evaluateScopeAuthorization } from '../src/services/policyEngine.js';

beforeEach(resetDatabase);

describe('policy engine (scope enforcement removed -- always ALLOW)', () => {
  it('allows a target with no authorized scope at all', async () => {
    const orgId = await createOrg();
    const decision = await evaluateScopeAuthorization({ orgId, target: 'example.com', requestedClass: 'RESTRICTED' });
    expect(decision.decision).toBe('ALLOW');
    expect(decision.reason).toBe('scope_enforcement_removed');
  });

  it('classifies the target type from the target string, with no scope to draw it from', async () => {
    const orgId = await createOrg();
    expect((await evaluateScopeAuthorization({ orgId, target: 'example.com', requestedClass: 'PASSIVE' })).targetType).toBe('DOMAIN');
    expect((await evaluateScopeAuthorization({ orgId, target: 'https://example.com', requestedClass: 'PASSIVE' })).targetType).toBe('URL');
    expect((await evaluateScopeAuthorization({ orgId, target: '10.0.0.1', requestedClass: 'PASSIVE' })).targetType).toBe('IP');
    expect((await evaluateScopeAuthorization({ orgId, target: '10.0.0.0/24', requestedClass: 'PASSIVE' })).targetType).toBe('CIDR');
    expect((await evaluateScopeAuthorization({ orgId, target: 'https://github.com/org/repo', requestedClass: 'PASSIVE' })).targetType).toBe('REPOSITORY');
  });

  it('records an audit event for every evaluation', async () => {
    const orgId = await createOrg();
    await evaluateScopeAuthorization({ orgId, target: 'example.com', requestedClass: 'PASSIVE' });
    const { rows } = await query('SELECT * FROM audit_events WHERE org_id = $1', [orgId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('policy.evaluate');
    expect(rows[0].result).toBe('ALLOW');
  });
});
