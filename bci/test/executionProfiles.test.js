import { describe, expect, it } from 'vitest';
import { NUCLEI_TEMPLATES_VERSION, resolveNucleiScope, resolveNaabuScope, resolveFuzzBaseScope, resolveAuthProfile } from '../src/engines/executionProfiles.js';

describe('canonical engine execution profiles', () => {
  it('pins official Nuclei templates and rejects unknown categories', () => {
    expect(NUCLEI_TEMPLATES_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(resolveNucleiScope('EXTENDED').categories).toContain('VULNERABILITY');
    expect(() => resolveNucleiScope('STANDARD', ['DOS'])).toThrow(/unknown Nuclei/);
    expect(() => resolveNucleiScope('BCI_BUNDLED', ['CVE'])).toThrow(/cannot select/);
  });

  it('maps Naabu presets and validates CUSTOM without shell syntax', () => {
    expect(resolveNaabuScope('TOP_PORTS').args).toEqual(['-top-ports', '100']);
    expect(resolveNaabuScope('PORTS_1_1000').executed).toBe('1-1000');
    expect(resolveNaabuScope('FULL_PORTS').args).toEqual(['-p', '-']);
    expect(resolveNaabuScope('CUSTOM', '80,443,8000-8100').executed).toBe('80,443,8000-8100');
    expect(() => resolveNaabuScope('CUSTOM', '80; whoami')).toThrow(/CUSTOM ports/);
    expect(() => resolveNaabuScope('CUSTOM', '9000-8000')).toThrow(/invalid CUSTOM/);
  });

  it('allows STANDARD, EXTENDED, uncapped FULL and user CUSTOM fuzz scope', () => {
    expect(resolveFuzzBaseScope('STANDARD').maxParameters).toBe(15);
    expect(resolveFuzzBaseScope('EXTENDED').maxParameters).toBe(50);
    expect(resolveFuzzBaseScope('FULL').maxParameters).toBeNull();
    expect(resolveFuzzBaseScope('CUSTOM', 501).maxParameters).toBe(501);
  });

  it('resolves named deployment auth profiles', () => {
    process.env.BCI_AUTH_PROFILE_TEST_ADMIN = JSON.stringify(['Authorization: Bearer test', 'X-Tenant: test']);
    expect(resolveAuthProfile('test_admin')).toEqual({ profileId: 'TEST_ADMIN', headers: ['Authorization: Bearer test', 'X-Tenant: test'] });
    expect(() => resolveAuthProfile('../../PATH')).toThrow(/invalid auth profile/);
    delete process.env.BCI_AUTH_PROFILE_TEST_ADMIN;
  });
  it('requires tenant and origin binding for legacy profiles at API/worker boundaries', () => {
    process.env.BCI_AUTH_PROFILE_BOUND = 'Authorization: Bearer private-token';
    expect(() => resolveAuthProfile('BOUND', { orgId: 'org-a', target: 'https://example.com' })).toThrow(/tenant/);
    process.env.BCI_AUTH_PROFILE_OWNER_BOUND = 'org-a';
    process.env.BCI_AUTH_PROFILE_ORIGIN_BOUND = 'https://example.com';
    expect(resolveAuthProfile('BOUND', { orgId: 'org-a', target: 'https://example.com' }).headers).toHaveLength(1);
    expect(() => resolveAuthProfile('BOUND', { orgId: 'org-b', target: 'https://example.com' })).toThrow(/tenant/);
    expect(() => resolveAuthProfile('BOUND', { orgId: 'org-a', target: 'https://other.example' })).toThrow(/target/);
    for (const key of ['BCI_AUTH_PROFILE_BOUND', 'BCI_AUTH_PROFILE_OWNER_BOUND', 'BCI_AUTH_PROFILE_ORIGIN_BOUND']) delete process.env[key];
  });
});
