import { describe, it, expect, beforeEach } from 'vitest';
import {
  isCloudProviderAllowed,
  filterAllowedProviders,
  assertProviderAllowed,
  PolicyDenialError,
} from './dataEgressPolicy.js';

beforeEach(() => {
  delete process.env.APPROVED_CLOUD_PROVIDERS;
});

describe('isCloudProviderAllowed', () => {
  it('PUBLIC: any provider allowed', () => {
    expect(isCloudProviderAllowed('PUBLIC', 'claude')).toBe(true);
    expect(isCloudProviderAllowed('PUBLIC', 'anything-unlisted')).toBe(true);
  });

  it('INTERNAL: only the approved set (default: all three)', () => {
    expect(isCloudProviderAllowed('INTERNAL', 'claude')).toBe(true);
    expect(isCloudProviderAllowed('INTERNAL', 'gemini')).toBe(true);
    expect(isCloudProviderAllowed('INTERNAL', 'openai')).toBe(true);
  });

  it('INTERNAL: narrows to an explicit approved list', () => {
    process.env.APPROVED_CLOUD_PROVIDERS = 'claude, gemini';
    expect(isCloudProviderAllowed('INTERNAL', 'claude')).toBe(true);
    expect(isCloudProviderAllowed('INTERNAL', 'openai')).toBe(false);
  });

  it('CONFIDENTIAL: only the approved set (default: all three), same as INTERNAL', () => {
    expect(isCloudProviderAllowed('CONFIDENTIAL', 'claude')).toBe(true);
    expect(isCloudProviderAllowed('CONFIDENTIAL', 'gemini')).toBe(true);
    expect(isCloudProviderAllowed('CONFIDENTIAL', 'openai')).toBe(true);
  });

  it('CONFIDENTIAL: narrows to an explicit approved list', () => {
    process.env.APPROVED_CLOUD_PROVIDERS = 'gemini';
    expect(isCloudProviderAllowed('CONFIDENTIAL', 'claude')).toBe(false);
    expect(isCloudProviderAllowed('CONFIDENTIAL', 'gemini')).toBe(true);
  });

  it('RESTRICTED: never allowed, unconditionally -- not even with every provider approved', () => {
    process.env.APPROVED_CLOUD_PROVIDERS = 'claude,gemini,openai';
    expect(isCloudProviderAllowed('RESTRICTED', 'claude')).toBe(false);
    expect(isCloudProviderAllowed('RESTRICTED', 'gemini')).toBe(false);
    expect(isCloudProviderAllowed('RESTRICTED', 'openai')).toBe(false);
  });

  it('fails closed on an unknown/missing classification', () => {
    expect(isCloudProviderAllowed('', 'claude')).toBe(false);
    expect(isCloudProviderAllowed(null, 'claude')).toBe(false);
    expect(isCloudProviderAllowed('NOT_A_REAL_LEVEL', 'claude')).toBe(false);
  });

  it('is case-insensitive on both classification and provider key', () => {
    expect(isCloudProviderAllowed('public', 'CLAUDE')).toBe(true);
  });
});

describe('filterAllowedProviders', () => {
  it('drops disallowed providers and keeps allowed ones, preserving order', () => {
    const providers = [{ key: 'claude' }, { key: 'gemini' }, { key: 'openai' }];
    process.env.APPROVED_CLOUD_PROVIDERS = 'gemini';
    const result = filterAllowedProviders('INTERNAL', providers, 'test-route');
    expect(result).toEqual([{ key: 'gemini' }]);
  });

  it('RESTRICTED filters every provider out', () => {
    const providers = [{ key: 'claude' }, { key: 'gemini' }, { key: 'openai' }];
    const result = filterAllowedProviders('RESTRICTED', providers, 'test-route');
    expect(result).toEqual([]);
  });
});

describe('assertProviderAllowed', () => {
  it('throws PolicyDenialError (fail closed) for a denied provider', () => {
    expect(() => assertProviderAllowed('RESTRICTED', 'claude', 'test-route')).toThrow(PolicyDenialError);
  });

  it('does not throw for an allowed provider', () => {
    expect(() => assertProviderAllowed('PUBLIC', 'claude', 'test-route')).not.toThrow();
  });

  it('PolicyDenialError carries a 403 status and a stable error code', () => {
    try {
      assertProviderAllowed('RESTRICTED', 'openai', 'test-route');
      expect.unreachable();
    } catch (err) {
      expect((err as PolicyDenialError).status).toBe(403);
      expect((err as PolicyDenialError).code).toBe('DATA_EGRESS_POLICY_DENIED');
    }
  });
});
