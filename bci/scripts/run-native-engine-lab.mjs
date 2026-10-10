import http from 'node:http';
import { mkdir,mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { createHash,randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const labRoot = path.join(os.homedir(),'.codex','bci-completion-lab');
if (process.env.BCI_ENABLE_NATIVE_LAB !== '1') throw new Error('Explicit isolated native lab flag required');
const installs = JSON.parse(await readFile('evidence/pentest-completion/engine-installation.json','utf8')).engines;
for (const engine of installs.filter((engine) => engine.status === 'INSTALLED')) process.env[`BCI_${engine.id.toUpperCase().replaceAll('-','_')}_BIN`] = engine.binary;
process.env.BCI_SEMGREP_BIN ||= path.join(labRoot,'semgrep-venv','Scripts','semgrep.exe');
process.env.NODE_ENV = 'test'; process.env.LOG_LEVEL = 'silent';
const {trivyAdapter} = await import('../src/engines/adapters/trivy.js');
const {osvScannerAdapter} = await import('../src/engines/adapters/osvScanner.js');
const {semgrepAdapter} = await import('../src/engines/adapters/semgrep.js');
const {nucleiAdapter} = await import('../src/engines/adapters/nuclei.js');
const {naabuAdapter} = await import('../src/engines/adapters/naabu.js');
await mkdir(labRoot,{recursive:true}); const fixture = await mkdtemp(path.join(labRoot,'native-scan-'));
await writeFile(path.join(fixture,'package-lock.json'),await readFile('test/fixtures/sca-sample/package-lock.json'));
await writeFile(path.join(fixture,'inert-source.js'),'export function inspect(input) { return eval(input); }\n');
// Random scanner canary strings, never issued by AWS or usable credentials.
await writeFile(path.join(fixture,'inert-canary.env'),`AWS_ACCESS_KEY_ID=AKIA${randomBytes(10).toString('hex').slice(0,16).toUpperCase()}\nAWS_SECRET_ACCESS_KEY=${randomBytes(30).toString('base64')}\n`);
const server = http.createServer((_req,res) => {res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>BCI isolated native engine laboratory</title>');});
await new Promise((resolve) => server.listen(0,'127.0.0.1',resolve));
const port = server.address().port; const target = `http://127.0.0.1:${port}`;
const results = [];
try {
  for (const [adapter,options] of [[trivyAdapter,{target:fixture,capabilities:['SECRETS']}],[osvScannerAdapter,{target:fixture}],[semgrepAdapter,{target:fixture,config:'BCI_CORE'}],[nucleiAdapter,{target,scanProfile:'BCI_BUNDLED',timeoutMs:120000}],[naabuAdapter,{target:'127.0.0.1',ports:String(port),rateLimit:5,timeoutMs:30000}]]) {
    const health = await adapter.healthCheck(); const started = new Date().toISOString();
    if (health.status !== 'HEALTHY') { results.push({engine:adapter.id,health,status:'NOT_EXECUTED',reason:'binary health check failed'}); continue; }
    try {
      const response = await adapter.execute(options);
      const count = response.executionMeta.resultCount;
      assert.ok(count > 0,`${adapter.id} did not identify its supplied laboratory canary`);
      if (adapter.id === 'naabu') assert.ok(response.raw.some((record) => Number(record.port) === port));
      results.push({engine:adapter.id,version:health.version,started,finished:new Date().toISOString(),status:'EXECUTED',resultCount:count,rawSha256:createHash('sha256').update(JSON.stringify(response.raw)).digest('hex'),executionMeta:response.executionMeta});
    } catch (error) { results.push({engine:adapter.id,version:health.version,status:'ERROR',reason:error.message.replaceAll(fixture,'[lab fixture]').slice(0,500)}); }
  }
} finally {
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  if (!path.resolve(fixture).startsWith(path.resolve(labRoot)+path.sep+'native-scan-')) throw new Error('unsafe lab cleanup');
  await rm(fixture,{recursive:true,force:true});
}
await writeFile('evidence/pentest-completion/native-engine-lab.json',JSON.stringify({executedAt:new Date().toISOString(),scope:'Isolated loopback HTTP and inert local repository fixtures',results},null,2));
console.log(JSON.stringify(results));
if (results.some((result) => result.status !== 'EXECUTED')) process.exitCode = 1;
