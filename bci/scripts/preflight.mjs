import {access} from 'node:fs/promises';
import {pool} from '../src/db/client.js';
import {runBinary} from '../src/engines/execFileAsync.js';
import {config} from '../src/config.js';
import {chromium} from 'playwright';
import {kmsReadiness} from '../src/pentest/kms.js';
import {vaultLifecycle} from '../src/pentest/vaultLifecycle.js';
const checks=[];
async function check(name,operation) {try {await operation();checks.push({name,status:'PASS'});} catch {checks.push({name,status:'FAIL'});}}
await check('migrations',async()=>{const r=await pool.query("SELECT filename FROM schema_migrations WHERE filename IN ('0046_pentest_schema_discovery.sql','0047_pentest_external_anchors.sql')");if(r.rows.length !== 2) throw new Error();});
await check('credential-provider',async()=> {
  if(process.env.BCI_PENTEST_KMS_KEY_ID) await kmsReadiness();
  else if(process.env.BCI_PENTEST_VAULT_URL) await vaultLifecycle('status');
  else throw new Error('external key management required');
});
await check('evidence-signing',async()=>{if(!process.env.BCI_PENTEST_EVIDENCE_PRIVATE_KEY || !process.env.BCI_PENTEST_EVIDENCE_PUBLIC_KEYS) throw new Error();});
await check('external-anchors',async()=>{if(!process.env.BCI_EVIDENCE_TSA_URL || !process.env.BCI_EVIDENCE_WORM_BUCKET) throw new Error();await access(process.env.BCI_EVIDENCE_TSA_CA_FILE);});
for(const [name,bin] of Object.entries(config.engineBins).filter(([name])=>name !== 'sshKeyscan')) await check(`scanner-${name}`,()=>runBinary(bin,[name === 'nuclei' || name === 'naabu' ? '-version' : '--version'],{timeoutMs:10000}));
await check('chromium',async()=>{const browser=await chromium.launch({headless:true});await browser.close();});
await pool.end();
console.log(JSON.stringify({ready:checks.every((c)=>c.status==='PASS'),checks},null,2));
if(checks.some((c)=>c.status==='FAIL')) process.exitCode=1;
