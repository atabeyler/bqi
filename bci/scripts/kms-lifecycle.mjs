import {provisionKmsKey,kmsReadiness} from '../src/pentest/kms.js';
const [operation,alias]=process.argv.slice(2);
try {
  if(!['provision','status','rotation'].includes(operation)) throw new Error('unsupported KMS lifecycle operation');
  const result=operation === 'provision' ? await provisionKmsKey(alias) : await kmsReadiness({enableRotation:operation === 'rotation'});
  console.log(JSON.stringify(result));
} catch(error) {console.error(error.message);process.exitCode=1;}
