import {it,expect} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {verifyEvidenceWriteCanary} from '../src/pentest/providerReadiness.js';
it('fails closed with machine-readable missing configuration before opening a database',async()=>{
 const env={...process.env,NODE_ENV:'production'};delete env.BCI_DATABASE_URL;delete env.BCI_JWT_SECRET;
 let failure;try{await promisify(execFile)(process.execPath,['scripts/preflight.mjs'],{env,timeout:15000,windowsHide:true});}catch(error){failure=error;}
 expect(failure.code).toBe(1);const report=JSON.parse(failure.stdout);
 expect(report.ready).toBe(false);expect(report.checks[0]).toEqual({name:'runtime-configuration',status:'BLOCKED',code:'CONFIGURATION_MISSING',required:['BCI_DATABASE_URL','BCI_JWT_SECRET']});
 expect(failure.stderr).toBe('');
});
it('refuses irreversible cloud canary writes without explicit operator configuration',async()=>{
 const previous=process.env.BCI_PREFLIGHT_CLOUD_CANARY_APPROVED;delete process.env.BCI_PREFLIGHT_CLOUD_CANARY_APPROVED;
 try{await expect(verifyEvidenceWriteCanary('11111111-1111-4111-8111-111111111111')).rejects.toThrow(/approval/);}finally{if(previous!==undefined)process.env.BCI_PREFLIGHT_CLOUD_CANARY_APPROVED=previous;}
});
