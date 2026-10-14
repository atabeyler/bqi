import {provisionKmsKey,kmsReadiness} from '../src/pentest/kms.js';
import {provisionHsmKeyStore} from '../src/pentest/kmsHsmStore.js';
import {readFile} from 'node:fs/promises';
const [operation,alias]=process.argv.slice(2);
try {
  if(operation==='provision-hsm-store'){console.log(JSON.stringify(await provisionHsmKeyStore(JSON.parse(await readFile(alias,'utf8')))));process.exit(0);}
  if(!['provision','status','rotation'].includes(operation)) throw new Error('unsupported KMS lifecycle operation');
  const result=operation === 'provision' ? await provisionKmsKey(alias) : await kmsReadiness({enableRotation:operation === 'rotation'});
  console.log(JSON.stringify(result));
} catch(error) {console.error(error.message);process.exitCode=1;}
