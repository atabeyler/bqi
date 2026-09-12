import { describe, it, expect } from 'vitest';
import { classifyKeyType, PQC_CLASSIFICATION_VERSION } from '../src/quantum/pqcClassification.js';

describe('classifyKeyType', () => {
  it('marks RSA, EC, and EdDSA as quantum-vulnerable with a scientific (not marketing) reason', () => {
    expect(classifyKeyType('rsa').quantumVulnerable).toBe(true);
    expect(classifyKeyType('rsa').note).toMatch(/Shor/);
    expect(classifyKeyType('ec').quantumVulnerable).toBe(true);
    expect(classifyKeyType('ed25519').quantumVulnerable).toBe(true);
  });

  it('marks NIST-standardized PQC algorithms as quantum-safe, citing the FIPS number not a vendor name', () => {
    const kem = classifyKeyType('ml-kem');
    expect(kem.quantumVulnerable).toBe(false);
    expect(kem.note).toMatch(/FIPS 203/);
  });

  it('fails closed (never "safe") for an unrecognized algorithm', () => {
    const result = classifyKeyType('some-future-algorithm');
    expect(result.quantumVulnerable).toBeNull();
    expect(result.note).toMatch(/unrecognized/);
  });

  it('classifies HMAC as not Shor-vulnerable, distinct from the RSA/EC quantum-vulnerable table', () => {
    const result = classifyKeyType('hmac');
    expect(result.algorithmId).toBe('HMAC');
    expect(result.quantumVulnerable).toBe(false);
  });

  it('flags jwt-none as unsigned, never as safe or unknown-but-maybe-vulnerable', () => {
    const result = classifyKeyType('jwt-none');
    expect(result.algorithmId).toBe('NONE');
    expect(result.quantumVulnerable).toBeNull();
    expect(result.note).toMatch(/unsigned/);
  });

  it('reports UNKNOWN, not a guess, when no key type was observed at all', () => {
    const result = classifyKeyType(null);
    expect(result.algorithmId).toBe('UNKNOWN');
    expect(result.quantumVulnerable).toBeNull();
  });

  it('every finding is stamped with a classification version string', () => {
    expect(PQC_CLASSIFICATION_VERSION).toMatch(/^pqc-classification-/);
  });
});
