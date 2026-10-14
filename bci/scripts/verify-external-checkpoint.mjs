import {readFile} from 'node:fs/promises';
import {latestCheckpoint} from '../src/pentest/immutableCheckpoint.js';
import {verifyIndependentChain} from '../src/pentest/independentVerification.js';
const [file,orgId,jobId]=process.argv.slice(2);
try{const checkpoint=await latestCheckpoint(orgId,jobId),report=JSON.parse(await readFile(file,'utf8'));if(report.integrity?.chain?.some((c)=>c.payload?.orgId!==orgId || c.payload?.jobId!==jobId))throw new Error();const result=verifyIndependentChain(report.integrity.chain,checkpoint.tail);console.log(JSON.stringify({...result,checkpoint}));if(result.status!=='VERIFIED')process.exitCode=1;}catch{console.error('External checkpoint verification failed');process.exitCode=1;}
