import {readFile} from 'node:fs/promises';
import {cloudHsmOperation} from '../src/pentest/cloudHsmLifecycle.js';
const [operation,file]=process.argv.slice(2);
try{if(!file)throw new Error('operator JSON configuration file required');const config=JSON.parse(await readFile(file,'utf8'));console.log(JSON.stringify(await cloudHsmOperation(operation,config),null,2));}catch{console.error('CloudHSM lifecycle operation blocked or failed; inspect operator configuration and CloudTrail');process.exitCode=1;}
