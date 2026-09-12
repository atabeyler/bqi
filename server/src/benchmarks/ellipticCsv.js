import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { normalizeEllipticLabel } from './ellipticAdapter.js';

function parseCsvLine(line) { const out=[]; let cell='',quoted=false; for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(quoted&&line[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){out.push(cell);cell='';}else cell+=c;}out.push(cell);return out; }
async function forEachCsvLine(filePath,onLine){const rl=readline.createInterface({input:fs.createReadStream(filePath,{encoding:'utf8'}),crlfDelay:Infinity});let index=0;for await(const line of rl)if(line.length)onLine(parseCsvLine(line),index++);}
async function readHeaderedCsv(filePath){const rows=[];let header=null;await forEachCsvLine(filePath,(values,i)=>{if(i===0){header=values;return;}rows.push(Object.fromEntries(header.map((key,j)=>[key,values[j]])));});return rows;}
async function readFeatureSamples(filePath){const samples=[];await forEachCsvLine(filePath,(values)=>{const features=new Float32Array(values.length-2);for(let i=2;i<values.length;i++){const n=Number(values[i]);features[i-2]=Number.isFinite(n)?n:0;}samples.push({id:values[0],source:'elliptic',timeStep:Number(values[1]),features});});return samples;}
export async function loadEllipticDataset(dataDir){const featuresPath=path.join(dataDir,'elliptic_txs_features.csv'),classesPath=path.join(dataDir,'elliptic_txs_classes.csv');const [samples,classObjects]=await Promise.all([readFeatureSamples(featuresPath),readHeaderedCsv(classesPath)]);const labels=new Map(classObjects.map(row=>[String(row.txId??row.txid),normalizeEllipticLabel(row.class??row.label)]));return{samples,labels,knownSampleCount:samples.reduce((n,s)=>n+(labels.get(s.id)!=='unknown'?1:0),0)};}
/**
 * Reads the Elliptic transaction-flow edge list (directed txId1 -> txId2).
 * Some distributions ship a "txId1,txId2" header row, others don't -- skip
 * the first row only when its first cell isn't a parseable id.
 */
export async function loadEllipticEdges(dataDir){const filePath=path.join(dataDir,'elliptic_txs_edgelist.csv');const edges=[];let first=true;await forEachCsvLine(filePath,(values)=>{if(values.length<2)return;if(first){first=false;if(!/^\d+$/.test(values[0].trim()))return;}edges.push([String(values[0]).trim(),String(values[1]).trim()]);});return edges;}
function subset(dataset,predicate){const samples=dataset.samples.filter(s=>Number.isFinite(s.timeStep)&&predicate(s.timeStep));const labels=new Map(samples.map(s=>[s.id,dataset.labels.get(s.id)||'unknown']));return{samples,labels,knownSampleCount:samples.filter(s=>labels.get(s.id)!=='unknown').length};}
/** Legacy chronological split retained for reproducibility. */
export function temporalSplit(dataset,opts={}){const trainEnd=opts.trainEnd??29,validationEnd=opts.validationEnd??39;if(trainEnd>=validationEnd)throw new Error('trainEnd must be below validationEnd');return{train:subset(dataset,t=>t<=trainEnd),validation:subset(dataset,t=>t>trainEnd&&t<=validationEnd),test:subset(dataset,t=>t>validationEnd),boundaries:{trainEnd,validationEnd}};}
/**
 * Four-way chronological split. The holdout is never used for fitting, orientation,
 * threshold, gate, or architecture selection. Default Elliptic steps are 1..49:
 * train 1..29, validation 30..39, development-test 40..44, final holdout 45..49.
 */
export function temporalHoldoutSplit(dataset,opts={}){const trainEnd=opts.trainEnd??29,validationEnd=opts.validationEnd??39,developmentEnd=opts.developmentEnd??44;if(!(trainEnd<validationEnd&&validationEnd<developmentEnd))throw new Error('boundaries must increase');return{train:subset(dataset,t=>t<=trainEnd),validation:subset(dataset,t=>t>trainEnd&&t<=validationEnd),developmentTest:subset(dataset,t=>t>validationEnd&&t<=developmentEnd),holdout:subset(dataset,t=>t>developmentEnd),boundaries:{trainEnd,validationEnd,developmentEnd}};}
