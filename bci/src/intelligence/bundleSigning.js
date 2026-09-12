import { createHash, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';

// Offline Intelligence Bundle signing (spec section 53). Ed25519, not an
// HMAC shared secret: a Sovereign/air-gapped instance only ever needs the
// PUBLIC key to verify a bundle -- it never holds anything that could be
// used to forge one, unlike a shared symmetric secret would require. Uses
// the one-shot crypto.sign()/crypto.verify() functions rather than the
// streaming Sign/Verify classes, since Ed25519 (unlike RSA/ECDSA) isn't a
// pre-hash-then-sign scheme and Node's streaming API doesn't support it.
export function generateBundleKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, k) => { acc[k] = canonicalize(value[k]); return acc; }, {});
  }
  return value;
}

function canonicalBytes(payload) {
  return Buffer.from(JSON.stringify(canonicalize(payload)));
}

export function signBundlePayload(payload, privateKeyPem) {
  const bytes = canonicalBytes(payload);
  const signature = cryptoSign(null, bytes, privateKeyPem);
  return {
    payload,
    signatureAlgorithm: 'ed25519',
    signature: signature.toString('base64'),
    payloadSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

// Fails closed on anything ambiguous: a missing signature, a payload whose
// hash doesn't match what was signed (tampered after signing), or a
// signature that doesn't verify against the given public key are all
// simply "not valid" -- never partially trusted.
export function verifyBundle(bundle, publicKeyPem) {
  if (!bundle?.payload || !bundle?.signature || !bundle?.payloadSha256) return false;

  const bytes = canonicalBytes(bundle.payload);
  const expectedHash = createHash('sha256').update(bytes).digest('hex');
  if (expectedHash !== bundle.payloadSha256) return false;

  try {
    return cryptoVerify(null, bytes, publicKeyPem, Buffer.from(bundle.signature, 'base64'));
  } catch {
    return false;
  }
}
