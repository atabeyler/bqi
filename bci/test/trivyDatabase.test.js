import {it,expect,afterEach} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {trivyDatabaseReady} from '../src/engines/trivyDatabase.js';
let cache;
afterEach(async()=>{if(cache) await rm(cache,{recursive:true,force:true});});
async function fixture({database=true,expired=false,version=2}={}) {
  cache=await mkdtemp(path.join(os.tmpdir(),'bci-trivy-metadata-unit-'));await mkdir(path.join(cache,'db'));
  await writeFile(path.join(cache,'db','metadata.json'),JSON.stringify({Version:version,NextUpdate:new Date(Date.now()+(expired ? -60000 : 60000)).toISOString(),DownloadedAt:new Date().toISOString()}));
  if(database) await writeFile(path.join(cache,'db','trivy.db'),'unit fixture: this is not a real scanner database');
  return cache;
}
it('accepts fresh supported metadata only when its database file exists',async()=>{expect(await trivyDatabaseReady(await fixture())).toBe(true);});
it('rejects metadata-only caches so preparation cannot report success without a DB',async()=>{expect(await trivyDatabaseReady(await fixture({database:false}))).toBe(false);});
it('rejects expired and unsupported database versions',async()=>{
  expect(await trivyDatabaseReady(await fixture({expired:true}))).toBe(false);
  await writeFile(path.join(cache,'db','metadata.json'),JSON.stringify({Version:1,NextUpdate:new Date(Date.now()+60000).toISOString(),DownloadedAt:new Date().toISOString()}));
  expect(await trivyDatabaseReady(cache)).toBe(false);
});
