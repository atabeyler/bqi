import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
const exec = promisify(execFile);
// Publisher release assets, verified against GitHub's immutable asset digests.
// Changes require a reviewed manifest update; runtime scans never update tools.
export const engines = [
  {id:'trivy',version:'0.75.0',repo:'aquasecurity/trivy',asset:'trivy_0.75.0_windows-64bit.zip',sha256:'4e43bd71a30f51aee39525f60f2b47043af77eb8df8fe082aae4372b69c6660f'},
  {id:'osv-scanner',version:'2.6.0',repo:'google/osv-scanner',asset:'osv-scanner_windows_amd64.exe',sha256:'e0ed7644118b717b028c249ee9d3515024e55e8510747ca08906eb96765354d6'},
  {id:'nuclei',version:'3.11.1',repo:'projectdiscovery/nuclei',asset:'nuclei_3.11.1_windows_amd64.zip',sha256:'bb6cb9ff8939b753f6fcab06fd30a15f5bc61d8382a597871334c007a85ff9d2'},
  {id:'naabu',version:'2.6.1',repo:'projectdiscovery/naabu',asset:'naabu_2.6.1_windows_amd64.zip',sha256:'4efaa341f36a0c6e676164f75e2d93d5a72f4090d690fd1bc293f5a4b79c202b'},
];
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This lab manifest requires Windows x64; production uses Dockerfile.worker');
const root = path.join(os.homedir(),'.codex','bci-completion-lab','engines');
await mkdir(root,{recursive:true});
const settled = await Promise.allSettled(engines.map(async (engine) => {
  const folder = path.join(root,`${engine.id}-${engine.version}`); await mkdir(folder,{recursive:true});
  const archive = path.join(folder,engine.asset);
  const url = `https://github.com/${engine.repo}/releases/download/v${engine.version}/${engine.asset}`;
  let bytes; try { bytes = await readFile(archive); } catch { /* download below */ }
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== engine.sha256) {
    await exec('curl.exe',['--fail','--location','--continue-at','-','--retry','2','--max-time','480','--output',archive,url],{windowsHide:true,timeout:1450000,maxBuffer:1024*1024});
    bytes = await readFile(archive);
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== engine.sha256) throw new Error(`${engine.id} publisher digest mismatch`);
  await writeFile(archive,bytes);
  if (engine.asset.endsWith('.zip')) {
    const listing = await exec('tar',['-tf',archive],{windowsHide:true,maxBuffer:1024*1024});
    for (const entry of listing.stdout.trim().split(/\r?\n/)) if (/^[\\/]|^[A-Za-z]:|(^|[\\/])\.\.([\\/]|$)/.test(entry)) throw new Error('unsafe publisher archive path');
    await exec('tar',['-xf',archive,'-C',folder],{windowsHide:true});
  }
  const binary = path.join(folder,engine.asset.endsWith('.exe') ? engine.asset : `${engine.id}.exe`);
  const version = await exec(binary,[engine.id === 'trivy' || engine.id === 'osv-scanner' ? '--version' : '-version'],{windowsHide:true,timeout:10000});
  return {...engine,url,binary,actualSha256:actual,versionOutput:(version.stdout+version.stderr).trim(),status:'INSTALLED'};
}));
const results = settled.map((result,index) => result.status === 'fulfilled' ? result.value : {...engines[index],status:'OFFLINE',reason:result.reason?.name === 'TimeoutError' ? 'download timeout' : 'download, integrity or version check failed'});
await mkdir('evidence/pentest-completion',{recursive:true});
await writeFile('evidence/pentest-completion/engine-installation.json',JSON.stringify({executedAt:new Date().toISOString(),platform:process.platform,engines:results},null,2));
console.log(JSON.stringify(results.map(({id,version,status}) => ({id,version,status}))));
if (results.some((result) => result.status !== 'INSTALLED')) process.exitCode = 1;
