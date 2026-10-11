import {it,expect} from 'vitest';
import https from 'node:https';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runBinary} from '../../src/engines/execFileAsync.js';
it('verifies a real RFC3161 timestamp, certificate chain, imprint and nonce over TLS',async()=> {
  const dir=await mkdtemp(path.join(os.tmpdir(),'bci-timestamp-lab-'));
  const openssl=process.env.BCI_OPENSSL_BIN || 'openssl';let server;
  const file=(name)=>path.join(dir,name);
  const command=(args)=>runBinary(openssl,args,{timeoutMs:10000});
  try {
    await command(['req','-x509','-newkey','rsa:2048','-nodes','-keyout',file('ca.key'),'-out',file('ca.pem'),'-days','1','-subj','/CN=BCI isolated timestamp CA']);
    for(const name of ['server','tsa']) {
      await command(['req','-new','-newkey','rsa:2048','-nodes','-keyout',file(`${name}.key`),'-out',file(`${name}.csr`),'-subj',`/CN=BCI ${name}`]);
      await writeFile(file(`${name}.ext`),name === 'server' ? 'basicConstraints=CA:FALSE\nsubjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' : 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,timeStamping\n');
      await command(['x509','-req','-in',file(`${name}.csr`),'-CA',file('ca.pem'),'-CAkey',file('ca.key'),'-CAcreateserial','-out',file(`${name}.pem`),'-days','1','-extfile',file(`${name}.ext`)]);
    }
    await writeFile(file('serial'),'01\n');
    await writeFile(file('tsa.cnf'),`[tsa]\ndefault_tsa=lab\n[lab]\nserial=${file('serial').replaceAll('\\','/')}\nsigner_cert=${file('tsa.pem').replaceAll('\\','/')}\ncerts=${file('ca.pem').replaceAll('\\','/')}\nsigner_key=${file('tsa.key').replaceAll('\\','/')}\nsigner_digest=sha256\ndefault_policy=1.2.3.4.1\nother_policies=1.2.3.4.2\ndigests=sha256,sha512\naccuracy=secs:1\nordering=yes\ntsa_name=yes\ness_cert_id_chain=no\ness_cert_id_alg=sha256\n`);
    server=https.createServer({key:await readFile(file('server.key')),cert:await readFile(file('server.pem'))},async(req,res)=> {
      try {
        const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>256*1024)throw new Error();chunks.push(chunk);}
        await writeFile(file('request.tsq'),Buffer.concat(chunks));
        await command(['ts','-reply','-config',file('tsa.cnf'),'-queryfile',file('request.tsq'),'-out',file('reply.tsr')]);
        res.setHeader('Content-Type','application/timestamp-reply');res.end(await readFile(file('reply.tsr')));
      } catch {res.writeHead(500);res.end();}
    });
    await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
    const source=fileURLToPath(new URL('../../src/pentest/externalEvidence.js',import.meta.url)).replaceAll('\\','/');
    const code=`import {timestampEvidence} from ${JSON.stringify(`file:///${source.replace(/^\//,'')}`)};console.log(JSON.stringify(await timestampEvidence('ab'.repeat(32))));`;
    const result=await runBinary(process.execPath,['--input-type=module','-e',code],{timeoutMs:20000,env:{...process.env,BCI_OPENSSL_BIN:openssl,NODE_EXTRA_CA_CERTS:file('ca.pem'),BCI_EVIDENCE_TSA_CA_FILE:file('ca.pem'),BCI_EVIDENCE_TSA_URL:`https://127.0.0.1:${server.address().port}`}});
    const stamp=JSON.parse(result.stdout);expect(stamp.status).toBe('VERIFIED');expect(stamp.responseSha256).toMatch(/^[a-f0-9]{64}$/);
    await writeFile(file('tampered.tsr'),Buffer.from(stamp.response,'base64'));await writeFile(file('wrong.tsq'),Buffer.from(stamp.query,'base64'));
    await command(['ts','-query','-digest','cd'.repeat(32),'-sha256','-out',file('wrong.tsq')]);
    await expect(command(['ts','-verify','-queryfile',file('wrong.tsq'),'-in',file('tampered.tsr'),'-CAfile',file('ca.pem')])).rejects.toThrow();
  } finally {if(server){server.closeAllConnections();await new Promise((resolve)=>server.close(resolve));}await rm(dir,{recursive:true,force:true});}
},30000);
