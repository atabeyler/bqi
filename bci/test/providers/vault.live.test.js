import {it,expect,beforeEach,afterEach} from 'vitest';
import {randomBytes} from 'node:crypto';
import {vaultLifecycle} from '../../src/pentest/vaultLifecycle.js';
import {protectCredentials,unprotectCredentials,rewrapCredentials} from '../../src/pentest/vault.js';
import {provisionVaultRuntimeIdentity} from '../../src/pentest/vaultProvisioning.js';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {vaultRuntimeToken} from '../../src/pentest/vaultIdentity.js';
const kmsKey=process.env.BCI_PENTEST_KMS_KEY_ID;
beforeEach(()=>{delete process.env.BCI_PENTEST_KMS_KEY_ID;});
afterEach(()=>{if(kmsKey===undefined)delete process.env.BCI_PENTEST_KMS_KEY_ID;else process.env.BCI_PENTEST_KMS_KEY_ID=kmsKey;});
it('uses actual TLS Vault provisioning, tenant isolation, rotation, backup and restore',async()=> {
  const url=new URL(process.env.BCI_PENTEST_VAULT_URL);
  if(!['127.0.0.1','localhost'].includes(url.hostname) || process.env.BCI_PROVIDER_LAB !== '1') throw new Error('isolated Vault laboratory required');
  const key=`bci-lab-${randomBytes(6).toString('hex')}`;process.env.BCI_PENTEST_VAULT_TRANSIT_KEY=key;
  process.env.BCI_VAULT_ALLOW_TRANSIT_BACKUP='1';
  const enabled=await fetch(new URL('/v1/sys/mounts/transit',url),{method:'POST',headers:{'X-Vault-Token':process.env.BCI_PENTEST_VAULT_OPERATOR_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({type:'transit'})});
  if(!enabled.ok && enabled.status!==400) throw new Error('transit mount failed');
  await vaultLifecycle('provision');
  const material={headers:[],bearerToken:randomBytes(24).toString('hex')};
  const original=await protectCredentials(material,'lab-tenant-a');
  expect(original.ciphertext.startsWith('vault:v1:')).toBe(true);
  expect(await unprotectCredentials(original,'lab-tenant-a')).toEqual(material);
  await expect(unprotectCredentials(original,'lab-tenant-b')).rejects.toThrow();
  await vaultLifecycle('rotate');const rotated=await rewrapCredentials(original,'lab-tenant-a');
  expect(rotated.ciphertext.startsWith('vault:v2:')).toBe(true);expect(await unprotectCredentials(rotated,'lab-tenant-a')).toEqual(material);
  const backup=await vaultLifecycle('backup');
  process.env.BCI_PENTEST_VAULT_TRANSIT_KEY=`${key}-restored`;
  await vaultLifecycle('restore',backup);expect(await unprotectCredentials(rotated,'lab-tenant-a')).toEqual(material);
  expect((await vaultLifecycle('status')).latestVersion).toBe(2);
  // Exercise the actual AppRole exchange, not an operator token posing as a worker.
  const identity=await provisionVaultRuntimeIdentity(`bci-${randomBytes(6).toString('hex')}`);
  const directory=await mkdtemp(path.join(os.tmpdir(),'bci-vault-identity-'));
  const previousToken=process.env.BCI_PENTEST_VAULT_TOKEN;
  try {
    process.env.BCI_PENTEST_VAULT_ROLE_ID=identity.roleId;
    process.env.BCI_PENTEST_VAULT_SECRET_ID_FILE=path.join(directory,'secret-id');
    await writeFile(process.env.BCI_PENTEST_VAULT_SECRET_ID_FILE,identity.secretId,{mode:0o600});
    delete process.env.BCI_PENTEST_VAULT_TOKEN;
    const runtime=await vaultRuntimeToken();
    const protectedMaterial=await protectCredentials(material,'lab-worker-tenant');
    expect(await unprotectCredentials(protectedMaterial,'lab-worker-tenant')).toEqual(material);
    for(const deniedPath of [`transit/backup/${process.env.BCI_PENTEST_VAULT_TRANSIT_KEY}`,`transit/export/encryption-key/${process.env.BCI_PENTEST_VAULT_TRANSIT_KEY}`]) {
      const denied=await fetch(new URL(`/v1/${deniedPath}`,url),{headers:{'X-Vault-Token':runtime}});expect(denied.status).toBe(403);
    }
  } finally {
    process.env.BCI_PENTEST_VAULT_TOKEN=previousToken;
    delete process.env.BCI_PENTEST_VAULT_ROLE_ID;delete process.env.BCI_PENTEST_VAULT_SECRET_ID_FILE;
    await rm(directory,{recursive:true,force:true});
  }
});
