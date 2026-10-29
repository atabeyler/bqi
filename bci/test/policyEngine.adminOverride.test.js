import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), audit: vi.fn() }));
vi.mock('../src/db/client.js', () => ({ query: mocks.query }));
vi.mock('../src/services/audit.js', () => ({ recordAuditEvent: mocks.audit }));
import { evaluateScopeAuthorization } from '../src/services/policyEngine.js';

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('BCI_DISABLE_SCOPE_ENFORCEMENT', 'true');
  mocks.query.mockReset(); mocks.audit.mockReset();
  mocks.query.mockResolvedValue({ rows: [] });
});
afterEach(() => vi.unstubAllEnvs());
const request = { orgId: 'org-a', actorUserId: 'admin-a', target: 'example.invalid', requestedClass: 'SAFE_ACTIVE' };

describe('explicit system administrator scope override', () => {
  it('allows and audits a DB-confirmed system admin in the same organization', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    expect(await evaluateScopeAuthorization(request)).toMatchObject({ decision: 'ALLOW', reason: 'system_admin_scope_override' });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0][1]).toEqual(['admin-a', 'org-a']);
    expect(mocks.query.mock.calls[0][0]).toContain('u.blocked IS NOT TRUE');
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ result: 'ALLOW', actorUserId: 'admin-a', metadata: { requestedClass: 'SAFE_ACTIVE', reason: 'system_admin_scope_override' } }));
  });
  it('keeps the scope requirement when the administrator lookup finds no matching role', async () => {
    expect(await evaluateScopeAuthorization(request)).toMatchObject({ decision: 'DENY', reason: 'no_approved_scope' });
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });
  it.each(['false', ''])('keeps the scope requirement when the switch is %j', async (value) => {
    vi.stubEnv('BCI_DISABLE_SCOPE_ENFORCEMENT', value);
    expect(await evaluateScopeAuthorization(request)).toMatchObject({ decision: 'DENY', reason: 'no_approved_scope' });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0][0]).toContain('authorized_scopes');
  });
  it('still accepts an existing approved scope for ordinary users', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'scope-a', target_type: 'DOMAIN', target: 'example.invalid' }] })
      .mockResolvedValueOnce({ rows: [] });
    expect(await evaluateScopeAuthorization(request)).toMatchObject({ decision: 'ALLOW', reason: 'approved_scope', scopeId: 'scope-a' });
  });
  it('propagates a role lookup failure rather than granting access', async () => {
    mocks.query.mockRejectedValueOnce(new Error('DB unavailable'));
    await expect(evaluateScopeAuthorization(request)).rejects.toThrow('DB unavailable');
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
