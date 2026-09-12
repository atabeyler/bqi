import { describe, expect, it } from 'vitest';
import { canAccessClassification, requireClassificationAccess, requireRole, resolveRole, ROLES } from './rbac.js';

describe('resolveRole', () => {
  it('honors an explicit, recognized role claim', () => {
    expect(resolveRole({ role: 'viewer' })).toBe('viewer');
  });

  it('falls back to admin for legacy isAdmin tokens without a role claim', () => {
    expect(resolveRole({ isAdmin: true })).toBe(ROLES.ADMIN);
  });

  it('defaults to analyst for a non-admin token with no role claim', () => {
    expect(resolveRole({ userCode: 'X' })).toBe(ROLES.ANALYST);
  });

  it('treats an unrecognized role claim as untrusted and drops to the least-privilege role, even with isAdmin set', () => {
    expect(resolveRole({ role: 'superuser', isAdmin: true })).toBe(ROLES.VIEWER);
    expect(resolveRole({ role: 'superuser' })).toBe(ROLES.VIEWER);
  });
});

describe('canAccessClassification', () => {
  it('lets admin access every classification including RESTRICTED', () => {
    const admin = { role: ROLES.ADMIN };
    expect(canAccessClassification(admin, 'PUBLIC')).toBe(true);
    expect(canAccessClassification(admin, 'INTERNAL')).toBe(true);
    expect(canAccessClassification(admin, 'CONFIDENTIAL')).toBe(true);
    expect(canAccessClassification(admin, 'RESTRICTED')).toBe(true);
  });

  it('blocks analyst from RESTRICTED but allows CONFIDENTIAL and below', () => {
    const analyst = { role: ROLES.ANALYST };
    expect(canAccessClassification(analyst, 'CONFIDENTIAL')).toBe(true);
    expect(canAccessClassification(analyst, 'RESTRICTED')).toBe(false);
  });

  it('limits viewer to INTERNAL and below', () => {
    const viewer = { role: ROLES.VIEWER };
    expect(canAccessClassification(viewer, 'INTERNAL')).toBe(true);
    expect(canAccessClassification(viewer, 'CONFIDENTIAL')).toBe(false);
    expect(canAccessClassification(viewer, 'RESTRICTED')).toBe(false);
  });

  it('treats a missing/unrecognized classification as INTERNAL, not a free pass', () => {
    const viewer = { role: ROLES.VIEWER };
    expect(canAccessClassification(viewer, undefined)).toBe(true);
    expect(canAccessClassification(viewer, 'NOT_A_REAL_LEVEL')).toBe(true);
  });
});

describe('requireRole middleware', () => {
  it('calls next() when the resolved role is allowed', () => {
    const req = { user: { role: ROLES.ADMIN } };
    const res = { status: () => res, json: () => {} };
    let called = false;
    requireRole(ROLES.ADMIN)(req, res, () => { called = true; });
    expect(called).toBe(true);
  });

  it('403s when the resolved role is not allowed', () => {
    const req = { user: { role: ROLES.VIEWER } };
    let statusCode = null;
    const res = { status(code) { statusCode = code; return res; }, json: () => {} };
    requireRole(ROLES.ADMIN)(req, res, () => { throw new Error('should not call next'); });
    expect(statusCode).toBe(403);
  });
});

describe('requireClassificationAccess middleware', () => {
  it('calls next() when the role can access the resolved classification', () => {
    const req = { user: { role: ROLES.ANALYST } };
    const res = { status: () => res, json: () => {} };
    let called = false;
    requireClassificationAccess(() => 'CONFIDENTIAL')(req, res, () => { called = true; });
    expect(called).toBe(true);
  });

  it('403s when the role cannot access the resolved classification', () => {
    const req = { user: { role: ROLES.VIEWER } };
    let statusCode = null;
    const res = { status(code) { statusCode = code; return res; }, json: () => {} };
    requireClassificationAccess(() => 'RESTRICTED')(req, res, () => { throw new Error('should not call next'); });
    expect(statusCode).toBe(403);
  });
});
