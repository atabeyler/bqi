import {it,expect} from 'vitest';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {randomBytes,generateKeyPairSync} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {backupDatabase,restoreDatabase} from '../src/services/databaseRecovery.js';
import {encryptCredentials,decryptCredentials} from '../src/pentest/vault.js';
import {sealEvidence,verifyEvidence} from '../src/pentest/evidence.js';
function installed(bin){try{execFileSync(bin,['--version'],{stdio:'ignore'});return true;}catch{return false;}}
const available=installed(process.env.BCI_PG_DUMP_BIN || 'pg_dump') && installed(process.env.BCI_PG_RESTORE_BIN || 'pg_restore');
it.skipIf(!available && process.env.BCI_REQUIRE_DB_BACKUP_TESTS!=='1')('backs up real migrated PostgreSQL, restores encrypted data and signed evidence, and rejects destructive restores',async()=>{
 const base=new URL(process.env.BCI_DATABASE_URL),admin=new pg.Pool({connectionString:base.href}),suffix=randomBytes(6).toString('hex'),names=[`bci_recovery_source_${suffix}`,`bci_recovery_restore_${suffix}`],directory=await mkdtemp(path.join(os.tmpdir(),'bci-recovery-'));
 const previous={key:process.env.BCI_PENTEST_VAULT_KEY,privateKey:process.env.BCI_PENTEST_EVIDENCE_PRIVATE_KEY,publicKey:process.env.BCI_PENTEST_EVIDENCE_PUBLIC_KEY};const pools=[];
 try {
  process.env.BCI_PENTEST_VAULT_KEY=randomBytes(32).toString('hex');const keys=generateKeyPairSync('ed25519');process.env.BCI_PENTEST_EVIDENCE_PRIVATE_KEY=keys.privateKey.export({type:'pkcs8',format:'pem'});process.env.BCI_PENTEST_EVIDENCE_PUBLIC_KEY=keys.publicKey.export({type:'spki',format:'pem'});
  const urls=[];for(const name of names){await admin.query(`CREATE DATABASE "${name}"`);const url=new URL(base);url.pathname='/'+name;urls.push(url.href);pools.push(new pg.Pool({connectionString:url.href}));}
  await promisify(execFile)(process.execPath,['src/db/migrate.js'],{env:{...process.env,BCI_DATABASE_URL:urls[0]},windowsHide:true,timeout:90000});
  const source=pools[0],destination=pools[1],secret=randomBytes(24).toString('hex'),payload={orgId:'recovery-lab',jobId:'owned-job',previousHash:null,records:[{result:'PASS'}]},envelope=sealEvidence(payload),encrypted=encryptCredentials({headers:[],bearerToken:secret},'recovery-lab');
  await source.query('CREATE TABLE recovery_crypto_fixture(id INTEGER PRIMARY KEY,secret JSONB NOT NULL,payload JSONB NOT NULL,envelope JSONB NOT NULL)');
  await source.query('INSERT INTO recovery_crypto_fixture VALUES(1,$1,$2,$3)',[encrypted,payload,envelope]);
  const before=(await source.query('SELECT filename FROM schema_migrations ORDER BY filename')).rows;
  const file=path.join(directory,'full.dump'),backup=await backupDatabase(urls[0],file);expect(backup.bytes).toBeGreaterThan(0);
  await expect(backupDatabase(urls[0],file)).rejects.toThrow(/overwritten/);
  await expect(restoreDatabase(urls[0],file,backup.sha256)).rejects.toThrow(/empty/);
  await expect(restoreDatabase(urls[1],file,'0'.repeat(64))).rejects.toThrow(/digest/);
  await restoreDatabase(urls[1],file,backup.sha256);
  const restored=(await destination.query('SELECT * FROM recovery_crypto_fixture')).rows[0];expect(decryptCredentials(restored.secret,'recovery-lab').bearerToken===secret).toBe(true);expect(verifyEvidence(restored.payload,restored.envelope)).toBe('VERIFIED');
  expect((await destination.query('SELECT filename FROM schema_migrations ORDER BY filename')).rows).toEqual(before);
  await promisify(execFile)(process.execPath,['src/db/migrate.js'],{env:{...process.env,BCI_DATABASE_URL:urls[1]},windowsHide:true,timeout:90000});
  await destination.query('SELECT id,org_id,config,revoked_at FROM pentest_engagements LIMIT 1');
  await destination.query('BEGIN');await destination.query("UPDATE recovery_crypto_fixture SET payload='{}'");await destination.query('ROLLBACK');
  expect(verifyEvidence((await destination.query('SELECT payload FROM recovery_crypto_fixture')).rows[0].payload,envelope)).toBe('VERIFIED');
  expect((await readFile(file)).subarray(0,5).toString()).toBe('PGDMP');
 }finally{for(const p of pools)await p.end();for(const name of names)await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH(FORCE)`);await admin.end();await rm(directory,{recursive:true,force:true});for(const [env,value] of [['BCI_PENTEST_VAULT_KEY',previous.key],['BCI_PENTEST_EVIDENCE_PRIVATE_KEY',previous.privateKey],['BCI_PENTEST_EVIDENCE_PUBLIC_KEY',previous.publicKey]]){if(value===undefined)delete process.env[env];else process.env[env]=value;}}
},180000);
