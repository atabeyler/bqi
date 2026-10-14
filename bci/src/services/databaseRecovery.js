import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile,unlink,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import pg from 'pg';
const execute=promisify(execFile);
async function inspectArchive(file){
 const hash=createHash('sha256');let header=Buffer.alloc(0);
 for await(const chunk of createReadStream(file)){if(header.length<5)header=Buffer.concat([header,chunk.subarray(0,5-header.length)]);hash.update(chunk);}
 if(header.toString()!=='PGDMP')throw new Error('invalid archive');
 return {sha256:hash.digest('hex'),bytes:(await stat(file)).size};
}
export async function backupDatabase(connectionString,file) {
 let reserved=false;
 try {
  await writeFile(file,'',{mode:0o600,flag:'wx'});reserved=true;
  await execute(process.env.BCI_PG_DUMP_BIN || 'pg_dump',['--format=custom','--compress=9','--no-owner','--no-acl','--file',file],{env:{...process.env,PGDATABASE:connectionString},windowsHide:true,timeout:300000,maxBuffer:65536});
  return {file,...await inspectArchive(file)};
 }catch{if(reserved)await unlink(file).catch(()=>{});throw new Error('database backup failed; existing files were not overwritten');}
}
export async function restoreDatabase(connectionString,file,expectedSha256) {
 const pool=new pg.Pool({connectionString,max:1,connectionTimeoutMillis:5000});
 try {
  if(!/^[a-f0-9]{64}$/.test(expectedSha256) || (await inspectArchive(file)).sha256!==expectedSha256)throw new Error();
  const {rows}=await pool.query("SELECT count(*)::int AS objects FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'");
  if(rows[0].objects!==0)throw new Error();
  await execute(process.env.BCI_PG_RESTORE_BIN || 'pg_restore',['--dbname','','--single-transaction','--exit-on-error','--no-owner','--no-acl',file],{env:{...process.env,PGDATABASE:connectionString},windowsHide:true,timeout:300000,maxBuffer:65536});
  return {restored:true,integrity:'SHA256_VERIFIED',transactional:true};
 }catch{throw new Error('database restore refused or failed; require matching digest and an empty isolated destination');}finally{await pool.end();}
}
