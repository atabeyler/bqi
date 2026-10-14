import {evidenceRetentionPolicy} from '../../src/pentest/retentionPolicy.js';
import {it,expect} from 'vitest';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {protectCredentials,unprotectCredentials,rewrapCredentials} from '../../src/pentest/vault.js';
import {sealEvidence} from '../../src/pentest/evidence.js';
import {archiveEvidence,verifyArchivedEvidence} from '../../src/pentest/externalEvidence.js';
import {publishCheckpoint,latestCheckpoint} from '../../src/pentest/immutableCheckpoint.js';
import {verifyEvidenceBuckets} from '../../src/pentest/providerReadiness.js';
import {kmsReadiness} from '../../src/pentest/kms.js';
const live=process.env.BCI_PROVIDER_AWS_LAB==='1';
function requireLab(){
 for(const name of ['AWS_REGION','BCI_PENTEST_KMS_KEY_ID','BCI_EVIDENCE_S3_KMS_KEY_ID','BCI_EVIDENCE_WORM_BUCKET','BCI_EVIDENCE_CHECKPOINT_BUCKET','BCI_PREFLIGHT_TENANT_ID'])if(!process.env[name])throw new Error(`Missing isolated AWS lab configuration: ${name}`);
 if(!['BCI_EVIDENCE_WORM_BUCKET','BCI_EVIDENCE_CHECKPOINT_BUCKET'].every((name)=>process.env[name].startsWith('bci-lab-')))throw new Error('Dedicated bci-lab buckets and irreversible retention approval required');
 evidenceRetentionPolicy();
 return process.env.BCI_PREFLIGHT_TENANT_ID;
}
it.skipIf(!live)('encrypts, rejects foreign tenant context and rewraps using the actual AWS KMS service',async()=>{
 const tenant=requireLab();await kmsReadiness();
 if(!process.env.BCI_PENTEST_KMS_ROTATION_TEST_KEY_ID)throw new Error('A separate isolated replacement KMS key is required to verify actual key rotation');
 const secret={canary:randomUUID()},envelope=await protectCredentials(secret,tenant);
 expect(await unprotectCredentials(envelope,tenant)).toEqual(secret);
 await expect(unprotectCredentials(envelope,randomUUID())).rejects.toThrow();
 const previous=process.env.BCI_PENTEST_KMS_KEY_ID;
 try{process.env.BCI_PENTEST_KMS_KEY_ID=process.env.BCI_PENTEST_KMS_ROTATION_TEST_KEY_ID;const rotated=await rewrapCredentials(envelope,tenant);expect(rotated.kmsKeyId).not.toBe(envelope.kmsKeyId);expect(await unprotectCredentials(rotated,tenant)).toEqual(secret);}finally{process.env.BCI_PENTEST_KMS_KEY_ID=previous;}
},60000);
it.skipIf(!live)('reads actual compliance retention, archived signature and a separate immutable checkpoint',async()=>{
 const tenant=requireLab();await verifyEvidenceBuckets();
 const names=['BCI_PENTEST_EVIDENCE_PRIVATE_KEY','BCI_PENTEST_EVIDENCE_PUBLIC_KEY','BCI_PENTEST_EVIDENCE_PUBLIC_KEYS','BCI_PENTEST_EVIDENCE_KEY_ID'],old=Object.fromEntries(names.map((n)=>[n,process.env[n]])),keys=generateKeyPairSync('ed25519');
 process.env.BCI_PENTEST_EVIDENCE_PRIVATE_KEY=keys.privateKey.export({type:'pkcs8',format:'pem'});process.env.BCI_PENTEST_EVIDENCE_PUBLIC_KEY=keys.publicKey.export({type:'spki',format:'pem'});delete process.env.BCI_PENTEST_EVIDENCE_PUBLIC_KEYS;process.env.BCI_PENTEST_EVIDENCE_KEY_ID='aws-isolated-lab';
 try{
  const payload={orgId:tenant,jobId:randomUUID(),previousHash:null,records:[],canary:randomUUID()},envelope=sealEvidence(payload);
  const archive=await archiveEvidence(payload,envelope,null);expect(archive.status).toBe('VERIFIED');expect((await verifyArchivedEvidence(archive)).hash).toBe(envelope.hash);
  expect((await publishCheckpoint(payload,envelope,1)).status).toBe('VERIFIED');
  expect(await latestCheckpoint(tenant,payload.jobId)).toEqual(expect.objectContaining({status:'VERIFIED',tail:envelope.hash,sequence:1}));
 }finally{for(const n of names)if(old[n]===undefined)delete process.env[n];else process.env[n]=old[n];}
},120000);
