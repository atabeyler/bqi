import {access,readdir} from 'node:fs/promises';
import {runBinary} from '../src/engines/execFileAsync.js';
import {chromium} from 'playwright';
import {kmsReadiness} from '../src/pentest/kms.js';
import {protectCredentials,unprotectCredentials} from '../src/pentest/vault.js';
import {sealEvidence,verifyEvidence} from '../src/pentest/evidence.js';
import {trivyDatabaseReady} from '../src/engines/trivyDatabase.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {verifyEvidenceBuckets,verifyEvidenceWriteCanary} from '../src/pentest/providerReadiness.js';
import {timestampEvidence} from '../src/pentest/externalEvidence.js';
import {evidenceRetentionPolicy} from '../src/pentest/retentionPolicy.js';
import {verifyDeployedIsolation} from '../src/pentest/deploymentReadiness.js';
const checks=[];
async function check(name,operation,required=[]) {const missing=required.filter((v)=>!process.env[v]);if(missing.length){checks.push({name,status:'BLOCKED',code:'CONFIGURATION_MISSING',required:missing});return;}try {await operation();checks.push({name,status:'PASS'});} catch {checks.push({name,status:'FAIL',code:'VERIFICATION_FAILED'});}}
const required=['BCI_DATABASE_URL',...(process.env.NODE_ENV==='production'?['BCI_JWT_SECRET']:[])];
if(required.some((v)=>!process.env[v])){console.log(JSON.stringify({ready:false,checks:[{name:'runtime-configuration',status:'BLOCKED',code:'CONFIGURATION_MISSING',required:required.filter((v)=>!process.env[v])}]}));process.exit(1);}
const {pool}=await import('../src/db/client.js'),{config}=await import('../src/config.js');
await check('migrations',async()=>{const files=(await readdir(new URL('../src/db/migrations/',import.meta.url))).filter((f)=>f.endsWith('.sql'));const r=await pool.query('SELECT filename FROM schema_migrations');if(files.some((f)=>!r.rows.some((v)=>v.filename===f))) throw new Error();});
await check('credential-provider',async()=> {
  if(process.env.BCI_PENTEST_KMS_KEY_ID) {
    await kmsReadiness();const tenant=process.env.BCI_PREFLIGHT_TENANT_ID || process.env.BCI_WORKER_ORG_ID;
    if(!tenant)throw new Error('tenant-bound canary required');
    const material={canary:randomBytes(32).toString('hex')},envelope=await protectCredentials(material,tenant);
    if((await unprotectCredentials(envelope,tenant)).canary!==material.canary)throw new Error();delete material.canary;
  }
  else if(process.env.BCI_PENTEST_VAULT_URL) {
    const tenant=randomUUID(),material={canary:randomBytes(32).toString('hex')};
    const envelope=await protectCredentials(material,tenant);
    if((await unprotectCredentials(envelope,tenant)).canary!==material.canary) throw new Error();
    delete material.canary;
  }
  else throw new Error('external key management required');
},process.env.BCI_PENTEST_VAULT_URL?['BCI_PENTEST_VAULT_URL']:['BCI_PENTEST_KMS_KEY_ID','AWS_REGION']);
await check('evidence-signing',async()=>{
  if(!process.env.BCI_PENTEST_EVIDENCE_PRIVATE_KEY || !process.env.BCI_PENTEST_EVIDENCE_PUBLIC_KEYS) throw new Error();
  const payload={preflight:randomUUID()},envelope=sealEvidence(payload);
  if(!JSON.parse(process.env.BCI_PENTEST_EVIDENCE_PUBLIC_KEYS)[envelope.keyId] || verifyEvidence(payload,envelope)!=='VERIFIED') throw new Error();
},['BCI_PENTEST_EVIDENCE_PRIVATE_KEY','BCI_PENTEST_EVIDENCE_PUBLIC_KEYS']);
await check('timestamp-authority',async()=>{await access(process.env.BCI_EVIDENCE_TSA_CA_FILE);await timestampEvidence(randomBytes(32).toString('hex'));},['BCI_EVIDENCE_TSA_URL','BCI_EVIDENCE_TSA_CA_FILE']);
await check('immutable-evidence-stores',async()=>{evidenceRetentionPolicy();await verifyEvidenceBuckets();},['AWS_REGION','BCI_EVIDENCE_WORM_BUCKET','BCI_EVIDENCE_CHECKPOINT_BUCKET','BCI_EVIDENCE_S3_KMS_KEY_ID','BCI_EVIDENCE_COMPLIANCE_APPROVED']);
await check('immutable-evidence-write-canary',()=>verifyEvidenceWriteCanary(process.env.BCI_PREFLIGHT_TENANT_ID),['BCI_PREFLIGHT_CLOUD_CANARY_APPROVED','BCI_PREFLIGHT_TENANT_ID','AWS_REGION','BCI_EVIDENCE_WORM_BUCKET','BCI_EVIDENCE_CHECKPOINT_BUCKET','BCI_EVIDENCE_S3_KMS_KEY_ID','BCI_EVIDENCE_COMPLIANCE_APPROVED','BCI_PENTEST_EVIDENCE_PRIVATE_KEY','BCI_PENTEST_EVIDENCE_PUBLIC_KEYS']);
for(const [name,bin] of Object.entries(config.engineBins).filter(([name])=>name !== 'sshKeyscan')) await check(`scanner-${name}`,()=>runBinary(bin,[name === 'nuclei' || name === 'naabu' ? '-version' : '--version'],{timeoutMs:name==='semgrep'?30000:10000}));
await check('trivy-database',async()=>{if(!await trivyDatabaseReady()) throw new Error();});
await check('chromium',async()=>{const browser=await chromium.launch({headless:true});await browser.close();});
await check('deployment-network-isolation',verifyDeployedIsolation,['BCI_KUBE_CONTEXT','BCI_KUBE_NAMESPACE','BCI_KUBE_WORKER_POD','BCI_KUBE_CONTROL_POD','BCI_NETWORK_ALLOWED_CANARIES','BCI_NETWORK_DENIED_CANARIES']);
for(const [name,bin] of [['pg-dump',process.env.BCI_PG_DUMP_BIN || 'pg_dump'],['pg-restore',process.env.BCI_PG_RESTORE_BIN || 'pg_restore']])await check(name,()=>runBinary(bin,['--version'],{timeoutMs:5000}));
await pool.end();
console.log(JSON.stringify({ready:checks.every((c)=>c.status==='PASS'),checks},null,2));
if(checks.some((c)=>c.status!=='PASS')) process.exitCode=1;
