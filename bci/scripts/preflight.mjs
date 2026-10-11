import {access} from 'node:fs/promises';
import {pool} from '../src/db/client.js';
import {runBinary} from '../src/engines/execFileAsync.js';
import {config} from '../src/config.js';
import {chromium} from 'playwright';
import {kmsReadiness} from '../src/pentest/kms.js';
import {protectCredentials,unprotectCredentials} from '../src/pentest/vault.js';
import {sealEvidence,verifyEvidence} from '../src/pentest/evidence.js';
import {trivyDatabaseReady} from '../src/engines/trivyDatabase.js';
import {randomBytes,randomUUID} from 'node:crypto';
const checks=[];
async function check(name,operation) {try {await operation();checks.push({name,status:'PASS'});} catch {checks.push({name,status:'FAIL'});}}
await check('migrations',async()=>{const r=await pool.query("SELECT filename FROM schema_migrations WHERE filename IN ('0046_pentest_schema_discovery.sql','0047_pentest_external_anchors.sql','0048_pentest_discovery_jobs.sql')");if(r.rows.length !== 3) throw new Error();});
await check('credential-provider',async()=> {
  if(process.env.BCI_PENTEST_KMS_KEY_ID) await kmsReadiness();
  else if(process.env.BCI_PENTEST_VAULT_URL) {
    const tenant=randomUUID(),material={canary:randomBytes(32).toString('hex')};
    const envelope=await protectCredentials(material,tenant);
    if((await unprotectCredentials(envelope,tenant)).canary!==material.canary) throw new Error();
    delete material.canary;
  }
  else throw new Error('external key management required');
});
await check('evidence-signing',async()=>{
  if(!process.env.BCI_PENTEST_EVIDENCE_PRIVATE_KEY || !process.env.BCI_PENTEST_EVIDENCE_PUBLIC_KEYS) throw new Error();
  const payload={preflight:randomUUID()},envelope=sealEvidence(payload);
  if(!JSON.parse(process.env.BCI_PENTEST_EVIDENCE_PUBLIC_KEYS)[envelope.keyId] || verifyEvidence(payload,envelope)!=='VERIFIED') throw new Error();
});
await check('external-anchors',async()=>{if(!process.env.BCI_EVIDENCE_TSA_URL || !process.env.BCI_EVIDENCE_WORM_BUCKET) throw new Error();await access(process.env.BCI_EVIDENCE_TSA_CA_FILE);});
for(const [name,bin] of Object.entries(config.engineBins).filter(([name])=>name !== 'sshKeyscan')) await check(`scanner-${name}`,()=>runBinary(bin,[name === 'nuclei' || name === 'naabu' ? '-version' : '--version'],{timeoutMs:10000}));
await check('trivy-database',async()=>{if(!await trivyDatabaseReady()) throw new Error();});
await check('chromium',async()=>{const browser=await chromium.launch({headless:true});await browser.close();});
await pool.end();
console.log(JSON.stringify({ready:checks.every((c)=>c.status==='PASS'),checks},null,2));
if(checks.some((c)=>c.status==='FAIL')) process.exitCode=1;
