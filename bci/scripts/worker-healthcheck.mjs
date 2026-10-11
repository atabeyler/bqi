import {pool} from '../src/db/client.js';
import {readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
try {
  const {workers}=JSON.parse(await readFile(process.env.BCI_WORKER_HEALTH_FILE || path.join(os.tmpdir(),'bci-worker-health.json'),'utf8'));
  if(!Array.isArray(workers) || !workers.length) throw new Error();
  const result=await pool.query("SELECT count(*)::int AS healthy FROM job_workers WHERE worker_id=ANY($1::text[]) AND last_seen_at>now()-interval '90 seconds' AND status IN ('IDLE','BUSY')",[workers]);
  if(result.rows[0].healthy!==workers.length) throw new Error();
} catch {process.exitCode=1;} finally {await pool.end();}
