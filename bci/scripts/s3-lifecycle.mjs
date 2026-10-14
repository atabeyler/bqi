import {readFile} from 'node:fs/promises';
import {s3EvidencePlan,provisionEvidenceStores} from '../src/pentest/s3Lifecycle.js';
const [operation,file]=process.argv.slice(2);
try{const config=JSON.parse(await readFile(file,'utf8'));if(!['plan','provision'].includes(operation))throw new Error();console.log(JSON.stringify(operation==='plan'?s3EvidencePlan(config):await provisionEvidenceStores(config),null,2));}catch{console.error('S3 lifecycle failed; inspect configuration, IAM and owned resource state without publishing credentials');process.exitCode=1;}
