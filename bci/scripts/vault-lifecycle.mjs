import { readFile, writeFile } from 'node:fs/promises';
import { vaultLifecycle } from '../src/pentest/vaultLifecycle.js';
import {createCipheriv,createDecipheriv,publicEncrypt,privateDecrypt,randomBytes,constants} from 'node:crypto';
const [operation,path] = process.argv.slice(2);
try {
  if (['backup','restore'].includes(operation) && !path) throw new Error('backup/restore requires an operator-owned file path');
  let backup;
  if(operation === 'restore') {
    const sealed=JSON.parse(await readFile(path,'utf8'));
    const key=privateDecrypt({key:await readFile(process.env.BCI_VAULT_BACKUP_PRIVATE_KEY_FILE),oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},Buffer.from(sealed.key,'base64'));
    try {const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(sealed.iv,'hex'));decipher.setAuthTag(Buffer.from(sealed.tag,'hex'));backup=Buffer.concat([decipher.update(Buffer.from(sealed.data,'base64')),decipher.final()]).toString('utf8');} finally {key.fill(0);}
  }
  const result = await vaultLifecycle(operation,{...(operation === 'restore' ? {backup} : {})});
  if (operation === 'backup') {
    // Never print backup material and never overwrite an existing backup.
    const key=randomBytes(32),iv=randomBytes(12);
    try {
      const cipher=createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([cipher.update(result.backup,'utf8'),cipher.final()]);
      const wrapped=publicEncrypt({key:await readFile(process.env.BCI_VAULT_BACKUP_PUBLIC_KEY_FILE),oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},key);
      await writeFile(path,JSON.stringify({v:1,key:wrapped.toString('base64'),iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),data:data.toString('base64')}),{mode:0o600,flag:'wx'});
    } finally {key.fill(0);}
    console.log(JSON.stringify({operation,completed:true}));
  } else console.log(JSON.stringify(result));
} catch (error) { console.error(error.message); process.exitCode=1; }
