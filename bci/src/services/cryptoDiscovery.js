import tls from 'node:tls';
import crypto from 'node:crypto';
import net from 'node:net';
import { query } from '../db/client.js';
import { evaluateScopeAuthorization } from './policyEngine.js';
import { recordAuditEvent } from './audit.js';
import { runBinary } from '../engines/execFileAsync.js';
import { config } from '../config.js';
import { classifyKeyType, PQC_CLASSIFICATION_VERSION } from '../quantum/pqcClassification.js';

const FIXED_CURVE_BITS = { ed25519: 255, x25519: 255, ed448: 448, x448: 448 };
const NAMED_CURVE_BITS = { prime256v1: 256, secp256r1: 256, secp384r1: 384, secp521r1: 521, secp256k1: 256 };

function keySizeBits(keyType, details) {
  if (details?.modulusLength) return details.modulusLength;
  if (details?.namedCurve) return NAMED_CURVE_BITS[details.namedCurve] ?? null;
  return FIXED_CURVE_BITS[keyType] ?? null;
}

// A REAL TLS handshake against the target -- never a mock parser over a
// canned response. rejectUnauthorized:false is deliberate: Crypto
// Discovery's job is to inventory whatever certificate/algorithm the
// endpoint actually presents, trusted or not; certificate trust validation
// is a different (client-side) concern this feature does not police.
export function probeTlsEndpoint(host, port = 443, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    // SNI's servername must be a hostname, not a bare IP (RFC 6066) --
    // omit it for IP targets rather than passing a value Node will only
    // warn about and then ignore.
    const connectOptions = { host, port, rejectUnauthorized: false, timeout: timeoutMs };
    if (net.isIP(host) === 0) connectOptions.servername = host;
    const socket = tls.connect(connectOptions, () => {
      if (settled) return;
      try {
        const peerCert = socket.getPeerCertificate(true);
        if (!peerCert || !peerCert.raw) {
          throw new Error('no certificate presented by endpoint');
        }
        const cipher = socket.getCipher();
        const protocol = socket.getProtocol();
        const x509 = new crypto.X509Certificate(peerCert.raw);
        const keyType = x509.publicKey?.asymmetricKeyType ?? null;
        const details = x509.publicKey?.asymmetricKeyDetails ?? {};
        settled = true;
        socket.end();
        resolve({
          protocol,
          cipherSuite: cipher?.name ?? null,
          keyType,
          keySizeBits: keySizeBits(keyType, details),
          namedCurve: details.namedCurve ?? null,
          subject: x509.subject,
          issuer: x509.issuer,
          validFrom: x509.validFrom,
          validTo: x509.validTo,
          fingerprint256: x509.fingerprint256,
        });
      } catch (err) {
        settled = true;
        socket.destroy();
        reject(err);
      }
    });
    socket.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    socket.once('timeout', () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error('TLS connection timed out'));
    });
  });
}

// --- SSH host key discovery -------------------------------------------
// SSH's own public key wire format (RFC 4253 section 6.6): a sequence of
// uint32-length-prefixed fields. Decoding it ourselves (rather than just
// reporting the algorithm name ssh-keyscan already gives us) is what lets
// an RSA host key's real modulus length be reported instead of "unknown".
const SSH_KEY_TYPE_MAP = {
  'ssh-rsa': 'rsa',
  'ssh-dss': 'dsa',
  'ssh-ed25519': 'ed25519',
  'sk-ssh-ed25519@openssh.com': 'ed25519',
  'ecdsa-sha2-nistp256': 'ec',
  'ecdsa-sha2-nistp384': 'ec',
  'ecdsa-sha2-nistp521': 'ec',
  'sk-ecdsa-sha2-nistp256@openssh.com': 'ec',
};
const SSH_CURVE_MAP = {
  'ecdsa-sha2-nistp256': 'prime256v1',
  'ecdsa-sha2-nistp384': 'secp384r1',
  'ecdsa-sha2-nistp521': 'secp521r1',
  'sk-ecdsa-sha2-nistp256@openssh.com': 'prime256v1',
};

function parseSshWireFields(buf) {
  const fields = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    offset += 4;
    if (len < 0 || offset + len > buf.length) break;
    fields.push(buf.subarray(offset, offset + len));
    offset += len;
  }
  return fields;
}

// mpint bit length: SSH mpints carry a leading 0x00 byte when the high bit
// of the first significant byte would otherwise be set (to keep them
// unambiguously positive) -- strip that padding before counting bits.
function mpintBitLength(buf) {
  let i = 0;
  while (i < buf.length && buf[i] === 0) i++;
  const trimmed = buf.subarray(i);
  if (trimmed.length === 0) return 0;
  let bits = (trimmed.length - 1) * 8;
  let top = trimmed[0];
  while (top > 0) {
    bits++;
    top >>= 1;
  }
  return bits;
}

function sshKeySizeBits(sshType, namedCurve, keyType, keyBlob) {
  try {
    if (sshType === 'ssh-rsa') {
      const fields = parseSshWireFields(keyBlob); // [type, e, n]
      if (fields[2]) return mpintBitLength(fields[2]);
    }
    if (sshType === 'ssh-dss') {
      const fields = parseSshWireFields(keyBlob); // [type, p, q, g, y]
      if (fields[1]) return mpintBitLength(fields[1]);
    }
  } catch {
    // Fall through to the algorithm-name-derived size below rather than throw
    // -- an unparseable blob still gets its algorithm name classified, just
    // with a null key size.
  }
  if (namedCurve) return NAMED_CURVE_BITS[namedCurve] ?? null;
  return FIXED_CURVE_BITS[keyType] ?? null;
}

// Real SSH host key retrieval via ssh-keyscan (OpenSSH, BSD-style license --
// the same "borrow the real, standard tool" approach as naabu/trivy/nuclei).
// Never sends credentials, never authenticates -- ssh-keyscan only performs
// the unauthenticated part of the SSH transport handshake needed to learn
// the server's host key(s).
export async function probeSshHostKeys(host, port = 22, timeoutMs = 8000) {
  const { stdout } = await runBinary(
    config.engineBins.sshKeyscan,
    ['-p', String(port), '-T', String(Math.max(1, Math.ceil(timeoutMs / 1000))), host],
    { timeoutMs: timeoutMs + 5000 }
  );

  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    throw new Error('no SSH host keys returned (host unreachable, SSH not running, or connection timed out)');
  }

  return lines.map((line) => {
    const parts = line.split(/\s+/);
    const sshType = parts[1];
    const base64Key = parts[2];
    const keyType = SSH_KEY_TYPE_MAP[sshType] ?? null;
    const namedCurve = SSH_CURVE_MAP[sshType] ?? null;
    const keyBlob = base64Key ? Buffer.from(base64Key, 'base64') : Buffer.alloc(0);
    return {
      sshAlgorithmName: sshType,
      keyType,
      namedCurve,
      keySizeBits: sshKeySizeBits(sshType, namedCurve, keyType, keyBlob),
    };
  });
}

function hostnameFromTarget(targetType, target) {
  if (targetType === 'URL' || targetType === 'API') {
    try {
      return new URL(target).hostname;
    } catch {
      return target;
    }
  }
  return target;
}

async function insertCryptoFinding(orgId, source, target, fields) {
  const classification = classifyKeyType(fields.keyType);
  const { rows } = await query(
    `INSERT INTO crypto_findings (
       org_id, source, target, protocol, cipher_suite, key_type, key_size_bits, named_curve,
       algorithm_id, quantum_vulnerable, classification_note, classification_version,
       cert_subject, cert_issuer, cert_not_before, cert_not_after, cert_fingerprint
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING *`,
    [
      orgId, source, target,
      fields.protocol ?? null, fields.cipherSuite ?? null, fields.keyType ?? null, fields.keySizeBits ?? null, fields.namedCurve ?? null,
      classification.algorithmId, classification.quantumVulnerable, classification.note, PQC_CLASSIFICATION_VERSION,
      fields.subject ?? null, fields.issuer ?? null,
      fields.validFrom ? new Date(fields.validFrom) : null, fields.validTo ? new Date(fields.validTo) : null,
      fields.fingerprint256 ?? null,
    ]
  );
  return rows[0];
}

// The one entry point for network-probe-based discovery (TLS, SSH).
export async function runCryptoDiscovery({ orgId, actorUserId, target, port, protocol = 'TLS' }) {
  const { targetType } = await evaluateScopeAuthorization({ orgId, actorUserId, target, requestedClass: 'SAFE_ACTIVE' });

  const host = hostnameFromTarget(targetType, target);

  if (protocol === 'SSH') {
    let hostKeys;
    try {
      hostKeys = await probeSshHostKeys(host, port ?? 22);
    } catch (err) {
      const error = String(err.message || err);
      await recordAuditEvent({ orgId, actorUserId, action: 'crypto.discover', targetType: 'crypto_finding', targetId: target, result: 'FAILED', metadata: { protocol: 'SSH', error } });
      return { accepted: true, discovered: false, error };
    }

    const findings = [];
    for (const hostKey of hostKeys) {
      const finding = await insertCryptoFinding(orgId, 'SSH', target, { protocol: hostKey.sshAlgorithmName, ...hostKey });
      findings.push(finding);
    }
    await recordAuditEvent({
      orgId, actorUserId, action: 'crypto.discover', targetType: 'crypto_finding', targetId: target,
      result: 'SUCCESS', metadata: { protocol: 'SSH', target, hostKeyCount: findings.length },
    });
    return { accepted: true, discovered: true, findings };
  }

  let probe;
  try {
    probe = await probeTlsEndpoint(host, port ?? 443);
  } catch (err) {
    const error = String(err.message || err);
    await recordAuditEvent({
      orgId, actorUserId, action: 'crypto.discover', targetType: 'crypto_finding', targetId: target,
      result: 'FAILED', metadata: { protocol: 'TLS', error },
    });
    return { accepted: true, discovered: false, error };
  }

  const finding = await insertCryptoFinding(orgId, 'TLS', target, probe);

  await recordAuditEvent({
    orgId, actorUserId, action: 'crypto.discover', targetType: 'crypto_finding', targetId: finding.id,
    result: 'SUCCESS', metadata: { protocol: 'TLS', target, algorithmId: finding.algorithm_id, quantumVulnerable: finding.quantum_vulnerable },
  });

  return { accepted: true, discovered: true, finding };
}

// --- Non-network crypto material inspection ----------------------------
// These two never make a network connection -- they inspect crypto
// material the caller already possesses (a JWT they hold, a code-signing
// certificate they extracted from a signed artifact) -- so they don't go
// through scope authorization; there is no "target" being scanned.

// JWT signing algorithm discovery: decodes the header only, never verifies
// the signature (verification needs the actual signing key/secret, which
// isn't the point here -- this is an algorithm inventory, not an auth check).
export async function discoverJwtAlgorithm({ orgId, actorUserId, token, label = 'jwt' }) {
  const parts = String(token).split('.');
  if (parts.length < 2) throw new Error('not a JWT (expected at least header.payload)');

  let header;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    throw new Error('JWT header is not valid base64url-encoded JSON');
  }

  const alg = header.alg;
  const mapped = mapJwtAlgToKeyType(alg);
  const finding = await insertCryptoFinding(orgId, 'JWT', label, {
    protocol: `JWT/${alg}`,
    keyType: mapped.keyType,
    keySizeBits: mapped.keySizeBits,
  });

  await recordAuditEvent({
    orgId, actorUserId, action: 'crypto.discover', targetType: 'crypto_finding', targetId: finding.id,
    result: 'SUCCESS', metadata: { protocol: 'JWT', alg, kid: header.kid ?? null },
  });

  return finding;
}

function mapJwtAlgToKeyType(alg) {
  if (!alg) return { keyType: null, keySizeBits: null };
  const a = String(alg).toUpperCase();
  if (a === 'NONE') return { keyType: 'jwt-none', keySizeBits: null };
  if (a.startsWith('RS') || a.startsWith('PS')) return { keyType: 'rsa', keySizeBits: null };
  if (a.startsWith('ES')) {
    const curveBits = { ES256: 256, ES384: 384, ES512: 521 }[a] ?? null;
    return { keyType: 'ec', keySizeBits: curveBits };
  }
  if (a === 'EDDSA') return { keyType: 'ed25519', keySizeBits: 255 };
  if (a.startsWith('HS')) return { keyType: 'hmac', keySizeBits: null };
  return { keyType: null, keySizeBits: null };
}

// Code-signing certificate discovery: classifies a certificate the caller
// already has in hand (extracted from a signed binary/package) -- PEM or
// DER, same X509 parsing path as the TLS probe above, just without a
// network connection to get the bytes from.
export async function discoverCodeSigningCertificate({ orgId, actorUserId, pem, label = 'code-signing-cert' }) {
  let x509;
  try {
    x509 = new crypto.X509Certificate(pem);
  } catch (err) {
    throw new Error(`not a valid X.509 certificate: ${err.message}`, { cause: err });
  }

  const keyType = x509.publicKey?.asymmetricKeyType ?? null;
  const details = x509.publicKey?.asymmetricKeyDetails ?? {};

  const finding = await insertCryptoFinding(orgId, 'CODE_SIGNING', label, {
    keyType,
    keySizeBits: keySizeBits(keyType, details),
    namedCurve: details.namedCurve ?? null,
    subject: x509.subject,
    issuer: x509.issuer,
    validFrom: x509.validFrom,
    validTo: x509.validTo,
    fingerprint256: x509.fingerprint256,
  });

  await recordAuditEvent({
    orgId, actorUserId, action: 'crypto.discover', targetType: 'crypto_finding', targetId: finding.id,
    result: 'SUCCESS', metadata: { protocol: 'CODE_SIGNING', algorithmId: finding.algorithm_id },
  });

  return finding;
}

export async function listCryptoFindings(orgId) {
  const { rows } = await query('SELECT * FROM crypto_findings WHERE org_id = $1 ORDER BY discovered_at DESC', [orgId]);
  return rows;
}
