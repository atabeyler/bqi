import { runBinary } from '../src/engines/execFileAsync.js';
import { config } from '../src/config.js';
import {trivyDatabaseReady,downloadMirroredTrivyDatabase} from '../src/engines/trivyDatabase.js';
const repositories = (process.env.BCI_TRIVY_DB_REPOSITORIES || 'ghcr.io/aquasecurity/trivy-db:2,mirror.gcr.io/aquasec/trivy-db:2').split(',');
const seconds = Number(process.env.BCI_TRIVY_DB_PREPARE_SECONDS || 1800);
if (!Number.isInteger(seconds) || seconds < 60 || seconds > 3600 || repositories.some((r)=>!/^[a-z0-9.-]+\/[a-z0-9/_-]+:2$/.test(r))) throw new Error('invalid Trivy DB preparation configuration');
try {
  if(!await trivyDatabaseReady()) {
    try {await runBinary(config.engineBins.trivy,['image','--download-db-only','--no-progress','--timeout','120s',...repositories.flatMap((r)=>['--db-repository',r])],{timeoutMs:130000});}
    catch {await downloadMirroredTrivyDatabase(undefined,AbortSignal.timeout(seconds*1000));}
  }
  if(!await trivyDatabaseReady()) throw new Error('Trivy database not ready');
  console.log(JSON.stringify({scanner:'trivy',database:'PREPARED',repositories}));
} catch { console.error('Trivy vulnerability database preparation failed; SCA must not be reported as completed'); process.exitCode=1; }
