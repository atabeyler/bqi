import { describe, it, expect } from 'vitest';
import { generateBundleKeyPair, signBundlePayload, verifyBundle } from '../src/intelligence/bundleSigning.js';

describe('offline intelligence bundle signing (pure)', () => {
  it('a bundle signed with the matching key verifies', () => {
    const { publicKeyPem, privateKeyPem } = generateBundleKeyPair();
    const bundle = signBundlePayload({ vulnerabilities: [{ cve_id: 'CVE-2099-1' }] }, privateKeyPem);
    expect(verifyBundle(bundle, publicKeyPem)).toBe(true);
  });

  it('fails verification against a DIFFERENT keypair\'s public key', () => {
    const signer = generateBundleKeyPair();
    const attacker = generateBundleKeyPair();
    const bundle = signBundlePayload({ vulnerabilities: [] }, signer.privateKeyPem);
    expect(verifyBundle(bundle, attacker.publicKeyPem)).toBe(false);
  });

  it('detects a tampered payload even if the signature blob is left untouched', () => {
    const { publicKeyPem, privateKeyPem } = generateBundleKeyPair();
    const bundle = signBundlePayload({ vulnerabilities: [{ cve_id: 'CVE-2099-1', kev: false }] }, privateKeyPem);

    const tampered = { ...bundle, payload: { ...bundle.payload, vulnerabilities: [{ cve_id: 'CVE-2099-1', kev: true }] } };
    expect(verifyBundle(tampered, publicKeyPem)).toBe(false);
  });

  it('rejects a bundle missing required fields', () => {
    const { publicKeyPem } = generateBundleKeyPair();
    expect(verifyBundle({}, publicKeyPem)).toBe(false);
    expect(verifyBundle({ payload: {} }, publicKeyPem)).toBe(false);
  });

  it('is order-independent (canonical JSON) -- key insertion order does not change the signature validity', () => {
    const { publicKeyPem, privateKeyPem } = generateBundleKeyPair();
    const bundle = signBundlePayload({ b: 2, a: 1 }, privateKeyPem);
    const reordered = { ...bundle, payload: { a: 1, b: 2 } };
    expect(verifyBundle(reordered, publicKeyPem)).toBe(true);
  });
});
