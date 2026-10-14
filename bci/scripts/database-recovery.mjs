import {backupDatabase,restoreDatabase} from '../src/services/databaseRecovery.js';
const [operation,file,hash]=process.argv.slice(2);
try{if(!process.env.BCI_DATABASE_URL || !file || !['backup','restore'].includes(operation))throw new Error();const result=operation==='backup'?await backupDatabase(process.env.BCI_DATABASE_URL,file):await restoreDatabase(process.env.BCI_DATABASE_URL,file,hash);console.log(JSON.stringify(result));}catch{console.error('Database recovery operation failed; existing backups and populated destinations are protected');process.exitCode=1;}
