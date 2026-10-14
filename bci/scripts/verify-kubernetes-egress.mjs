import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile} from 'node:fs/promises';
const execute=promisify(execFile),namespace='bci-network-lab';
const kubectl=async(args)=>JSON.parse((await execute('kubectl',['--context','kind-bci-egress-lab',...args],{timeout:60000,maxBuffer:1024*1024})).stdout);
const run=async(args)=>execute('kubectl',['--context','kind-bci-egress-lab',...args],{timeout:args.includes('wait')?300000:60000,maxBuffer:1024*1024});
if(process.env.BCI_KERNEL_LAB!=='1')throw new Error('explicit isolated Kubernetes lab flag required');
await run(['create','namespace',namespace]);
const code="const http=require('node:http');for(const port of [5432,8080,9090])http.createServer((q,s)=>s.end('BCI_NETWORK_CANARY')).listen(port,'::');";
for(const [name,app] of [['worker','bci-worker'],['database','bci-postgres'],['foreign','foreign'],['control','control']]) {
 const manifest={apiVersion:'v1',kind:'Pod',metadata:{name,namespace,labels:{app}},spec:{automountServiceAccountToken:false,securityContext:{runAsNonRoot:true,runAsUser:1000,seccompProfile:{type:'RuntimeDefault'}},containers:[{name:'canary',image:'node:22-bookworm-slim',command:['node','-e',code],securityContext:{allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,capabilities:{drop:['ALL']}},readinessProbe:{httpGet:{port:9090,path:'/'},initialDelaySeconds:1,periodSeconds:1}}]}};
 const file=`${process.env.RUNNER_TEMP || '/tmp'}/bci-network-${name}.json`;await writeFile(file,JSON.stringify(manifest));await run(['apply','-f',file]);
}
await run(['-n',namespace,'wait','--for=condition=Ready','pods','--all','--timeout=240s']);
async function addresses(name){return (await kubectl(['-n',namespace,'get','pod',name,'-o','json'])).status.podIPs.map((v)=>v.ip);}
const database=await addresses('database'),foreign=await addresses('foreign'),worker=await addresses('worker');
if([database,foreign,worker].some((ips)=>!ips.some((v)=>v.includes(':')) || !ips.some((v)=>!v.includes(':'))))throw new Error('real dual-stack pod addresses required');
function url(ip,port){return `http://${ip.includes(':')?'['+ip+']':ip}:${port}`;}
async function probe(pod,target,allowed){const source="fetch(process.argv[1],{signal:AbortSignal.timeout(2000)}).then(async r=>{const ok=r.ok&&(await r.text())==='BCI_NETWORK_CANARY';if(!ok||process.argv[2]!=='true')process.exit(1)}).catch(()=>{if(process.argv[2]==='true')process.exit(1)})";await run(['-n',namespace,'exec',pod,'--','node','-e',source,target,String(allowed)]);}
for(const ip of foreign)await probe('worker',url(ip,8080),true);
let policy=await (await import('node:fs/promises')).readFile('bci/deploy/worker-network-policy.yaml','utf8');
policy=policy.replace('  name: bci-worker-default-deny',`  name: bci-worker-default-deny\n  namespace: ${namespace}`);
const policyFile=`${process.env.RUNNER_TEMP || '/tmp'}/bci-worker-network-policy.yaml`;await writeFile(policyFile,policy);await run(['apply','-f',policyFile]);
await new Promise((resolve)=>setTimeout(resolve,5000));
for(const ip of database){await probe('worker',url(ip,5432),true);await probe('worker',url(ip,8080),false);}
for(const ip of foreign){await probe('control',url(ip,8080),true);await probe('worker',url(ip,8080),false);}
for(const ip of worker)await probe('foreign',url(ip,9090),false);
await run(['-n',namespace,'exec','worker','--','node','-e',"const fs=require('node:fs');const s=fs.readFileSync('/proc/self/status','utf8');if(process.getuid()===0||!/NoNewPrivs:\\s+1/.test(s)||!/CapEff:\\s+0+\\s/.test(s)||fs.existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token'))process.exit(1);try{fs.writeFileSync('/tmp/bci-readonly-canary','test');process.exit(1)}catch(e){if(e.code!=='EROFS')process.exit(1)}"]);
const proof={executedAt:new Date().toISOString(),cluster:'isolated kind with Calico',families:['IPv4','IPv6'],baselineReachability:true,allowedDatabasePort:true,unlistedPortDenied:true,foreignEgressDenied:true,workerIngressDenied:true,nonRoot:true,readOnlyRoot:true,privilegeEscalation:false};
await writeFile('bci/evidence/production-completion/kubernetes-network-results.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
