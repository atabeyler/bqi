import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import tls from 'node:tls';
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { query } from '../src/db/client.js';
import { resetDatabase, createOrg, createUser } from './helpers/db.js';
import { runCryptoDiscovery, probeTlsEndpoint, probeSshHostKeys, discoverJwtAlgorithm, discoverCodeSigningCertificate } from '../src/services/cryptoDiscovery.js';

const execFileAsync = promisify(execFile);

// describe.skipIf needs its condition known at collection time (before any
// beforeAll runs), so binary presence is checked synchronously here, up
// front -- exit code doesn't matter (bad-usage exits are still "installed"),
// only ENOENT means "not installed".
function binaryExists(bin, args) {
  try {
    execFileSync(bin, args, { stdio: 'ignore' });
    return true;
  } catch (err) {
    return err.code !== 'ENOENT';
  }
}
const SSH_TOOLING_AVAILABLE = binaryExists('ssh-keyscan', []) && binaryExists('/usr/sbin/sshd', ['-V']) && binaryExists('ssh-keygen', ['--help']);

beforeEach(resetDatabase);

async function approveScope(orgId, userId, target, targetType, classes = ['PASSIVE', 'SAFE_ACTIVE']) {
  await query(
    `INSERT INTO authorized_scopes (org_id, name, target, target_type, allowed_scan_classes, status, created_by, approved_by, approved_at)
     VALUES ($1,'scope',$2,$3,$4,'APPROVED',$5,$5,now())`,
    [orgId, target, targetType, classes, userId]
  );
}

// Real TLS servers with real, freshly generated certificates -- an RSA one
// and an EC one -- so Crypto Discovery is proven against actual handshakes,
// not a canned fixture standing in for one.
let workDir;
let rsaServer;
let ecServer;
let rsaPort;
let ecPort;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), 'bci-pqc-fixture-'));

  await execFileAsync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', path.join(workDir, 'rsa.key'), '-out', path.join(workDir, 'rsa.crt'),
    '-days', '1', '-nodes', '-subj', '/CN=localhost',
  ]);
  await execFileAsync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-keyout', path.join(workDir, 'ec.key'), '-out', path.join(workDir, 'ec.crt'),
    '-days', '1', '-nodes', '-subj', '/CN=localhost',
  ]);

  const [rsaKey, rsaCert, ecKey, ecCert] = await Promise.all([
    readFile(path.join(workDir, 'rsa.key')),
    readFile(path.join(workDir, 'rsa.crt')),
    readFile(path.join(workDir, 'ec.key')),
    readFile(path.join(workDir, 'ec.crt')),
  ]);

  rsaServer = tls.createServer({ key: rsaKey, cert: rsaCert }, (socket) => socket.end());
  ecServer = tls.createServer({ key: ecKey, cert: ecCert }, (socket) => socket.end());

  await new Promise((resolve) => rsaServer.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => ecServer.listen(0, '127.0.0.1', resolve));
  rsaPort = rsaServer.address().port;
  ecPort = ecServer.address().port;
}, 30_000);

afterAll(async () => {
  await new Promise((resolve) => rsaServer.close(resolve));
  await new Promise((resolve) => ecServer.close(resolve));
  await rm(workDir, { recursive: true, force: true });
});

// Real sshd, real freshly generated RSA/Ed25519 host keys -- same "spin up
// the real service" discipline as the TLS servers above. Skips gracefully
// (never a hard failure) if openssh-server/ssh-keyscan aren't installed in
// this environment, mirroring the engine adapters' OFFLINE-not-a-crash
// pattern; SSH_TOOLING_AVAILABLE was computed synchronously above the
// describe blocks below, where describe.skipIf needs it.
let sshProcess;
let sshPort;
let sshWorkDir;

beforeAll(async () => {
  if (!SSH_TOOLING_AVAILABLE) return;

  sshWorkDir = await mkdtemp(path.join(os.tmpdir(), 'bci-ssh-fixture-'));
  await mkdir('/run/sshd', { recursive: true });

  await execFileAsync('ssh-keygen', ['-t', 'rsa', '-b', '2048', '-f', path.join(sshWorkDir, 'hostkey_rsa'), '-N', '', '-q']);
  await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-f', path.join(sshWorkDir, 'hostkey_ed25519'), '-N', '', '-q']);

  sshPort = 20000 + Math.floor(Math.random() * 10000);
  const configPath = path.join(sshWorkDir, 'sshd_config');
  await writeFile(
    configPath,
    [
      `Port ${sshPort}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${path.join(sshWorkDir, 'hostkey_rsa')}`,
      `HostKey ${path.join(sshWorkDir, 'hostkey_ed25519')}`,
      `PidFile ${path.join(sshWorkDir, 'sshd.pid')}`,
      'StrictModes no',
      'UsePAM no',
      'PasswordAuthentication no',
      'AuthorizedKeysFile /dev/null',
    ].join('\n')
  );

  sshProcess = spawn('/usr/sbin/sshd', ['-f', configPath, '-D', '-e'], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 1000)); // real process startup, not a mock
}, 30_000);

afterAll(async () => {
  if (sshProcess) sshProcess.kill('SIGTERM');
  if (sshWorkDir) await rm(sshWorkDir, { recursive: true, force: true });
});

describe.skipIf(!SSH_TOOLING_AVAILABLE)('probeSshHostKeys (real SSH host key retrieval)', () => {
  it('discovers both the RSA and Ed25519 host keys with real, decoded key sizes', async () => {
    const keys = await probeSshHostKeys('127.0.0.1', sshPort);
    const rsa = keys.find((k) => k.keyType === 'rsa');
    const ed = keys.find((k) => k.keyType === 'ed25519');
    expect(rsa.keySizeBits).toBe(2048);
    expect(ed.keySizeBits).toBe(255);
  });

  it('rejects when nothing is listening', async () => {
    await expect(probeSshHostKeys('127.0.0.1', 1)).rejects.toThrow();
  });
});

describe.skipIf(!SSH_TOOLING_AVAILABLE)('runCryptoDiscovery (SSH protocol, integration)', () => {
  it('discovers and stores one crypto_findings row per host key, all marked quantum-vulnerable', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    await approveScope(orgId, userId, '127.0.0.1', 'IP');

    const result = await runCryptoDiscovery({ orgId, actorUserId: userId, target: '127.0.0.1', port: sshPort, protocol: 'SSH' });
    expect(result.accepted).toBe(true);
    expect(result.discovered).toBe(true);
    expect(result.findings.length).toBe(2);
    expect(result.findings.every((f) => f.source === 'SSH')).toBe(true);
    expect(result.findings.every((f) => f.quantum_vulnerable === true)).toBe(true);
  });

  it('runs SSH discovery with no authorized scope at all (scope enforcement removed), same as TLS', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    const result = await runCryptoDiscovery({ orgId, actorUserId: userId, target: '127.0.0.1', port: sshPort, protocol: 'SSH' });
    expect(result.accepted).toBe(true);
  });
});

describe('discoverJwtAlgorithm (no network, header inspection only)', () => {
  function makeJwt(header) {
    const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    return `${b64(header)}.${b64({ sub: 'x' })}.fakesignature`;
  }

  it('classifies an RS256 JWT as RSA, quantum-vulnerable', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    const finding = await discoverJwtAlgorithm({ orgId, actorUserId: userId, token: makeJwt({ alg: 'RS256', typ: 'JWT' }) });
    expect(finding.algorithm_id).toBe('RSA');
    expect(finding.quantum_vulnerable).toBe(true);
  });

  it('classifies an HS256 JWT as HMAC, not Shor-vulnerable', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    const finding = await discoverJwtAlgorithm({ orgId, actorUserId: userId, token: makeJwt({ alg: 'HS256' }) });
    expect(finding.algorithm_id).toBe('HMAC');
    expect(finding.quantum_vulnerable).toBe(false);
  });

  it('flags alg=none as unsigned, never as "safe"', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    const finding = await discoverJwtAlgorithm({ orgId, actorUserId: userId, token: makeJwt({ alg: 'none' }) });
    expect(finding.quantum_vulnerable).toBeNull();
    expect(finding.classification_note).toMatch(/unsigned/);
  });

  it('rejects a malformed token', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    await expect(discoverJwtAlgorithm({ orgId, actorUserId: userId, token: 'not-a-jwt' })).rejects.toThrow();
  });
});

describe('discoverCodeSigningCertificate (no network, caller-supplied certificate)', () => {
  it('classifies a real RSA code-signing-shaped certificate as RSA, quantum-vulnerable', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    const pem = await readFile(path.join(workDir, 'rsa.crt'), 'utf8');
    const finding = await discoverCodeSigningCertificate({ orgId, actorUserId: userId, pem, label: 'my-app.exe' });
    expect(finding.algorithm_id).toBe('RSA');
    expect(finding.target).toBe('my-app.exe');
  });

  it('rejects invalid certificate material', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    await expect(discoverCodeSigningCertificate({ orgId, actorUserId: userId, pem: 'not a cert' })).rejects.toThrow();
  });
});

describe('probeTlsEndpoint (real TLS handshake)', () => {
  it('identifies an RSA certificate as RSA with a real modulus length', async () => {
    const result = await probeTlsEndpoint('127.0.0.1', rsaPort);
    expect(result.keyType).toBe('rsa');
    expect(result.keySizeBits).toBe(2048);
    expect(result.subject).toMatch(/CN=localhost/);
  });

  it('identifies an EC certificate as ec with its named curve', async () => {
    const result = await probeTlsEndpoint('127.0.0.1', ecPort);
    expect(result.keyType).toBe('ec');
    expect(result.namedCurve).toBe('prime256v1');
  });

  it('rejects when nothing is listening on the port', async () => {
    await expect(probeTlsEndpoint('127.0.0.1', 1)).rejects.toThrow();
  });
});

describe('runCryptoDiscovery (integration, real DB + real TLS)', () => {
  it('accepts discovery even with no authorized scope at all (scope enforcement removed)', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });

    const result = await runCryptoDiscovery({ orgId, actorUserId: userId, target: '127.0.0.1', port: rsaPort });
    expect(result.accepted).toBe(true);
  });

  it('discovers and classifies an RSA endpoint as quantum-vulnerable, and stores it in crypto_findings', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    await approveScope(orgId, userId, '127.0.0.1', 'IP');

    const result = await runCryptoDiscovery({ orgId, actorUserId: userId, target: '127.0.0.1', port: rsaPort });
    expect(result.accepted).toBe(true);
    expect(result.discovered).toBe(true);
    expect(result.finding.algorithm_id).toBe('RSA');
    expect(result.finding.quantum_vulnerable).toBe(true);
    expect(result.finding.key_size_bits).toBe(2048);

    const { rows } = await query('SELECT * FROM crypto_findings WHERE org_id = $1', [orgId]);
    expect(rows).toHaveLength(1);
  });

  it('reports discovery failure honestly (accepted, not discovered) when nothing answers on the port', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    await approveScope(orgId, userId, '127.0.0.1', 'IP');

    const result = await runCryptoDiscovery({ orgId, actorUserId: userId, target: '127.0.0.1', port: 1 });
    expect(result.accepted).toBe(true);
    expect(result.discovered).toBe(false);
    expect(result.error).toBeDefined();
  });
});
