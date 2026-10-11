import {readFile,stat,mkdir,mkdtemp,writeFile,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {runBinary} from './execFileAsync.js';
export function trivyCacheDirectory() {
  return process.env.TRIVY_CACHE_DIR || (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || os.homedir(),'trivy') : path.join(os.homedir(),'.cache','trivy'));
}
export async function trivyDatabaseReady(cache=trivyCacheDirectory()) {
  try {
    const metadata=JSON.parse(await readFile(path.join(cache,'db','metadata.json'),'utf8'));
    const database=await stat(path.join(cache,'db','trivy.db'));
    return database.isFile() && database.size>0 && metadata.Version === 2 && Date.parse(metadata.NextUpdate)>Date.now() && Date.parse(metadata.DownloadedAt)>0;
  } catch {return false;}
}
// Fallback for slow OCI clients/proxies: bounded parallel range downloads,
// checked against the registry's content digest before any cache is replaced.
export async function downloadMirroredTrivyDatabase(cache=trivyCacheDirectory(),signal=AbortSignal.timeout(1800000)) {
  const base='https://mirror.gcr.io/v2/aquasec/trivy-db';
  const response=await fetch(`${base}/manifests/2`,{signal,headers:{Accept:'application/vnd.oci.image.manifest.v1+json'}});
  if(!response.ok) throw new Error('Trivy mirror manifest unavailable');
  const text=await response.text();if(text.length>16384) throw new Error('Trivy manifest limit exceeded');
  const manifest=JSON.parse(text),layer=manifest.layers?.[0];
  if(!/^sha256:[a-f0-9]{64}$/.test(layer?.digest) || !Number.isInteger(layer.size) || layer.size<1 || layer.size>256*1024*1024) throw new Error('Trivy manifest invalid');
  const count=12,width=Math.ceil(layer.size/count);
  const chunks=await Promise.all(Array.from({length:count},async(_,i)=> {
    const first=i*width,last=Math.min(layer.size-1,first+width-1);
    for(let attempt=0;attempt<3;attempt++) {
      signal.throwIfAborted();
      try {
        const result=await fetch(`${base}/blobs/${layer.digest}`,{signal,headers:{Range:`bytes=${first}-${last}`}});
        if(result.status !== 206 || result.headers.get('content-range') !== `bytes ${first}-${last}/${layer.size}`) {await result.body?.cancel();throw new Error('Trivy mirror range unsupported');}
        const parts=[];let size=0;
        for await(const part of result.body){size+=part.length;if(size>last-first+1) throw new Error('Trivy range limit exceeded');parts.push(Buffer.from(part));}
        if(size!==last-first+1) throw new Error('Trivy range incomplete');return Buffer.concat(parts);
      } catch {if(attempt===2 || signal.aborted) throw new Error('Trivy mirror download failed');}
    }
  }));
  const bytes=Buffer.concat(chunks);
  if(`sha256:${createHash('sha256').update(bytes).digest('hex')}`!==layer.digest) throw new Error('Trivy database digest mismatch');
  await mkdir(cache,{recursive:true});const dir=await mkdtemp(path.join(cache,'prepare-'));
  try {
    const archive=path.join(dir,'db.tar.gz');await writeFile(archive,bytes);
    const listing=await runBinary('tar',['-tzf',archive],{signal,timeoutMs:10000});
    if(listing.stdout.trim().split(/\r?\n/).some((entry)=>!['trivy.db','metadata.json'].includes(entry))) throw new Error('unexpected Trivy archive content');
    await runBinary('tar',['-xzf',archive,'-C',dir],{signal,timeoutMs:30000});
    const metadata=JSON.parse(await readFile(path.join(dir,'metadata.json'),'utf8'));
    if(metadata.Version!==2 || !(Date.parse(metadata.NextUpdate)>Date.now())) throw new Error('stale Trivy database');
    metadata.DownloadedAt=new Date().toISOString();await writeFile(path.join(dir,'metadata.json'),JSON.stringify(metadata));
    await mkdir(path.join(cache,'db'),{recursive:true});
    await rename(path.join(dir,'trivy.db'),path.join(cache,'db','trivy.db'));
    await rename(path.join(dir,'metadata.json'),path.join(cache,'db','metadata.json'));
    return {digest:layer.digest,bytes:layer.size};
  } finally {await rm(dir,{recursive:true,force:true});}
}
