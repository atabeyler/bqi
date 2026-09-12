// Data-driven PQC algorithm classification (spec: "PQC standardları
// versiyonlanmış/veri odaklı olmalı, hardcoded pazarlama ismi olmamalı").
// This table is the ONLY place BCI decides "quantum-vulnerable or not" --
// bumping PQC_CLASSIFICATION_VERSION is how that judgment changes, never a
// silent code edit buried in a normalizer. Every crypto_findings row stores
// the version it was classified under, so a later table update never
// silently rewrites the meaning of historical findings.
export const PQC_CLASSIFICATION_VERSION = 'pqc-classification-2026.1';

// Quantum-vulnerable: broken in polynomial time by Shor's algorithm on a
// sufficiently large fault-tolerant quantum computer -- a statement about
// the mathematical structure of the algorithm, not a claim that any such
// machine exists today or that today's traffic is being decrypted.
// Quantum-safe: standardized by NIST post-quantum cryptography process
// (FIPS 203/204/205, 2024), referenced by standard number, not a vendor
// product name.
const CLASSIFICATIONS = [
  { keyTypes: ['rsa', 'rsa-pss'], id: 'RSA', quantumVulnerable: true, brokenBy: "Shor's algorithm (integer factorization)" },
  { keyTypes: ['dsa'], id: 'DSA', quantumVulnerable: true, brokenBy: "Shor's algorithm (discrete logarithm)" },
  { keyTypes: ['ec'], id: 'ECDSA/ECDH', quantumVulnerable: true, brokenBy: "Shor's algorithm (elliptic curve discrete logarithm)" },
  { keyTypes: ['ed25519', 'ed448'], id: 'EdDSA', quantumVulnerable: true, brokenBy: "Shor's algorithm (elliptic curve discrete logarithm)" },
  { keyTypes: ['x25519', 'x448'], id: 'ECDH (X25519/X448)', quantumVulnerable: true, brokenBy: "Shor's algorithm (elliptic curve discrete logarithm)" },
  { keyTypes: ['ml-kem', 'kyber'], id: 'ML-KEM', quantumVulnerable: false, standard: 'NIST FIPS 203' },
  { keyTypes: ['ml-dsa', 'dilithium'], id: 'ML-DSA', quantumVulnerable: false, standard: 'NIST FIPS 204' },
  { keyTypes: ['slh-dsa', 'sphincs+'], id: 'SLH-DSA', quantumVulnerable: false, standard: 'NIST FIPS 205' },
  // Symmetric primitives (HMAC) are a different threat model entirely --
  // Grover's algorithm gives only a quadratic speedup against a symmetric
  // key, not the polynomial-time break Shor's algorithm gives against RSA/
  // EC. NIST guidance treats a sufficiently long symmetric key (>=256-bit)
  // as remaining adequate post-quantum -- this is NOT the same claim as
  // "quantum-safe" for an asymmetric algorithm, and is scored separately
  // from the RSA/EC/PQC table above rather than folded into it.
  { keyTypes: ['hmac'], id: 'HMAC', quantumVulnerable: false, standard: "not Shor-vulnerable; Grover's algorithm only quadratically weakens a symmetric key" },
];

// alg=none is not a cryptographic algorithm at all -- the JWT is unsigned.
// That's a distinct (and more urgent) security problem than a PQC
// migration question, so it's reported as its own case rather than folded
// into "quantum-vulnerable: true/false/unknown".
const JWT_NONE_KEY_TYPE = 'jwt-none';

export function classifyKeyType(asymmetricKeyType) {
  if (!asymmetricKeyType) {
    return { algorithmId: 'UNKNOWN', quantumVulnerable: null, note: 'no key type observed during discovery' };
  }
  const normalized = String(asymmetricKeyType).toLowerCase();
  if (normalized === JWT_NONE_KEY_TYPE) {
    return { algorithmId: 'NONE', quantumVulnerable: null, note: 'alg=none: token is unsigned -- not a cryptographic algorithm, a signature-missing issue' };
  }
  const match = CLASSIFICATIONS.find((c) => c.keyTypes.includes(normalized));
  if (!match) {
    // Fail closed toward caution: an algorithm this table has never heard of
    // is NEVER reported as "not vulnerable" -- that would be a guess dressed
    // up as a scientific finding.
    return { algorithmId: normalized.toUpperCase(), quantumVulnerable: null, note: `unrecognized key type "${normalized}" -- not classified by ${PQC_CLASSIFICATION_VERSION}` };
  }
  return {
    algorithmId: match.id,
    quantumVulnerable: match.quantumVulnerable,
    note: match.quantumVulnerable ? match.brokenBy : `quantum-safe per ${match.standard}`,
  };
}
