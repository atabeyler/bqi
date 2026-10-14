import {readFile} from 'node:fs/promises';
import {runtimeIamPlan,provisionRuntimeIam} from '../src/pentest/iamProvisioning.js';
const [operation,file]=process.argv.slice(2);
try{if(!['plan','provision'].includes(operation)||!file)throw new Error();const c=JSON.parse(await readFile(file,'utf8'));console.log(JSON.stringify(operation==='plan'?runtimeIamPlan(c):await provisionRuntimeIam(c),null,2));}catch{console.error('IAM configuration or provisioning failed');process.exitCode=1;}
