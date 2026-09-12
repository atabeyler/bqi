import path from 'node:path';
import { loadEllipticDataset, loadEllipticEdges, temporalHoldoutSplit } from '../src/benchmarks/ellipticCsv.js';
import { createElliptic5QScorer, createElliptic13QScorer, createRobustClassicalScorer } from '../src/benchmarks/ellipticScorers.js';
import { createBalancedLinearScorer } from '../src/benchmarks/supervisedLinearScorer.js';
import { createTemporalRegimeScorer } from '../src/benchmarks/temporalFeatureScorer.js';
import { createGraphAwareScorer } from '../src/benchmarks/ellipticGraphScorer.js';
import { createFpDiscriminator } from '../src/benchmarks/fpDiscriminator.js';
import { runBlindAmlBenchmark } from '../src/benchmarks/amlBenchmark.js';
import { binaryMetrics } from '../src/benchmarks/benchmarkMetrics.js';
import { selectOrientationAndThreshold, applyOrientation } from '../src/benchmarks/thresholdSelection.js';
import { selectConstrainedThreshold } from '../src/benchmarks/constrainedThresholdSelection.js';
const dataDir=path.resolve(process.argv[2]||process.env.ELLIPTIC_DATA_DIR||'./data/elliptic'),dataset=await loadEllipticDataset(dataDir),edges=await loadEllipticEdges(dataDir),split=temporalHoldoutSplit(dataset);
const classical=createRobustClassicalScorer(split.train.samples),linear=createBalancedLinearScorer(split.train),temporal=createTemporalRegimeScorer(split.train),q5=createElliptic5QScorer(split.train.samples),q13=createElliptic13QScorer(split.train.samples),graph=createGraphAwareScorer(split.train,edges),fp=await createFpDiscriminator(split.train,[linear,temporal,q5,q13]);
const scorers={classical,linear,temporal,q5,q13,graph,fp},labels=p=>p.samples.map(s=>p.labels.get(s.id)||'unknown'),vl=labels(split.validation),dl=labels(split.developmentTest),hl=labels(split.holdout),raw={validation:{},developmentTest:{},holdout:{}};
for(const [n,s] of Object.entries(scorers))for(const p of ['validation','developmentTest','holdout']){const r=await runBlindAmlBenchmark(split[p],{[n]:s},{threshold:.5});raw[p][n]=r.results[n].scores;}
const cSel=selectConstrainedThreshold(vl,raw.validation.classical,{minRecall:1}),names=['linear','temporal','q5','q13'],ori={};for(const n of [...names,'fp','graph'])ori[n]=selectOrientationAndThreshold(vl,raw.validation[n],{objective:'f1'}).orientation;
const O={};for(const p of ['validation','developmentTest','holdout']){O[p]={classical:applyOrientation(raw[p].classical,cSel.orientation)};for(const n of [...names,'fp','graph'])O[p][n]=applyOrientation(raw[p][n],ori[n]);}
function q(v,x){const a=v.filter(Number.isFinite).sort((a,b)=>a-b);return a[Math.floor(x*(a.length-1))];}
const qs=[0,.01,.02,.03,.05,.075,.10,.15],g={};for(const n of names){const il=O.validation[n].filter((_,i)=>vl[i]==='illicit');g[n]=[...new Set(qs.map(x=>q(il,x)))];}
function basePred(p,need,gs){return O[p].classical.map((c,i)=>{if(c<cSel.threshold)return 0;let low=0;for(let k=0;k<4;k++)if(O[p][names[k]][i]<gs[k])low++;return low>=need?0:1;});}
const candidates=[];for(const a of g.linear)for(const b of g.temporal)for(const c of g.q5)for(const d of g.q13)for(const need of [4,3,2]){const gs=[a,b,c,d],pv=basePred('validation',need,gs),m=binaryMetrics(vl,pv,.5);if(m.fn===0)candidates.push({need,gs,validation:m});}candidates.sort((a,b)=>a.validation.fp-b.validation.fp);
let stable=null;for(const c of candidates){const pd=basePred('developmentTest',c.need,c.gs),m=binaryMetrics(dl,pd,.5);if(m.fn===0){stable={...c,developmentTest:m};break;}}if(!stable)throw new Error('no stable zero-FN base policy');
// Stage-2 discriminator may clear only alarms produced by the stable base. Threshold candidates
// come solely from illicit validation scores; then development must also remain zero-FN.
const illicitFp=O.validation.fp.filter((_,i)=>vl[i]==='illicit'),thresholds=[0,.001,.0025,.005,.01,.02,.03,.05].map(x=>q(illicitFp,x));
function second(p,l,t){const base=basePred(p,stable.need,stable.gs);const pred=base.map((v,i)=>v&&O[p].fp[i]>=t?1:0);return binaryMetrics(l,pred,.5);}
const secondCandidates=[];for(const t of thresholds){const v=second('validation',vl,t);if(v.fn)continue;const d=second('developmentTest',dl,t);if(d.fn)continue;secondCandidates.push({threshold:t,validation:v,developmentTest:d});}
secondCandidates.sort((a,b)=>(a.validation.fp+a.developmentTest.fp)-(b.validation.fp+b.developmentTest.fp));const chosen=secondCandidates[0]||{threshold:-Infinity,validation:stable.validation,developmentTest:stable.developmentTest};
const finalHoldout=second('holdout',hl,chosen.threshold);
// Stage-3 graph veto sits on top of the stage-2 output and may only clear
// alarms that survived it. Its threshold candidates come from the transaction
// graph's illicit-neighborhood signal alone -- topology the other six voters
// never see -- selected under the same zero-FN-on-validation-AND-development
// discipline as every earlier stage. Holdout is still touched exactly once.
const illicitGraph=O.validation.graph.filter((_,i)=>vl[i]==='illicit'),graphThresholds=[0,.001,.0025,.005,.01,.02,.03,.05].map(x=>q(illicitGraph,x));
function third(p,l,t){const base=basePred(p,stable.need,stable.gs);const stage2=base.map((v,i)=>v&&O[p].fp[i]>=chosen.threshold?1:0);const pred=stage2.map((v,i)=>v&&O[p].graph[i]>=t?1:0);return binaryMetrics(l,pred,.5);}
const thirdCandidates=[];for(const t of graphThresholds){const v=third('validation',vl,t);if(v.fn)continue;const d=third('developmentTest',dl,t);if(d.fn)continue;thirdCandidates.push({threshold:t,validation:v,developmentTest:d});}
thirdCandidates.sort((a,b)=>(a.validation.fp+a.developmentTest.fp)-(b.validation.fp+b.developmentTest.fp));const chosenGraph=thirdCandidates[0]||{threshold:-Infinity,validation:chosen.validation,developmentTest:chosen.developmentTest};
const finalHoldoutGraph=third('holdout',hl,chosenGraph.threshold);
// Standalone diagnostic: how separable is the graph score by itself, with no
// cascade around it? This never feeds any selection decision -- it only tells
// us whether the graph signal exists at all before blaming the cascade shape.
const graphStandalone={validation:binaryMetrics(vl,O.validation.graph,.5),developmentTest:binaryMetrics(dl,O.developmentTest.graph,.5)};
// Independent 5-voter joint search: graph sits INSIDE the consensus gate
// alongside linear/temporal/q5/q13, instead of only filtering alarms the
// 4-voter base already produced (stage-3 above). This lets the graph voter
// veto alarms the other four would have kept. A precomputed-mask scan with
// early abort on the first false negative keeps the 8^5-combination grid
// tractable (same technique as this file's earlier validation-only Pareto
// search). Entirely separate from `stable`/`chosen`/`chosenGraph` above --
// the frozen 4-voter baseline is never touched by this block.
const names5=[...names,'graph'];
const g5={...g,graph:(()=>{const il=O.validation.graph.filter((_,i)=>vl[i]==='illicit');return[...new Set(qs.map(x=>q(il,x)))];})()};
function fastZeroFnSearch(p,l,needs){
  const known=[];for(let i=0;i<l.length;i++)if(l[i]!=='unknown')known.push(i);
  const base=known.map(i=>O[p].classical[i]>=cSel.threshold?1:0);
  const y=known.map(i=>l[i]==='illicit');
  const masks=names5.map(n=>g5[n].map(gval=>known.map(i=>O[p][n][i]<gval?1:0)));
  const results=[];
  for(let a=0;a<g5[names5[0]].length;a++)for(let b=0;b<g5[names5[1]].length;b++)for(let c=0;c<g5[names5[2]].length;c++)for(let d=0;d<g5[names5[3]].length;d++)for(let e=0;e<g5[names5[4]].length;e++)for(const need of needs){
    const idx=[a,b,c,d,e];let tp=0,fp=0,fn=0,tn=0,aborted=false;
    for(let r=0;r<known.length;r++){
      let pred=base[r];
      if(pred){let low=0;for(let k=0;k<5;k++)if(masks[k][idx[k]][r])low++;if(low>=need)pred=0;}
      if(y[r]){if(pred)tp++;else{fn++;aborted=true;break;}}
      else if(pred)fp++;else tn++;
    }
    if(aborted)continue;
    results.push({need,gs:names5.map((n,k)=>g5[n][idx[k]]),metrics:{tp,fp,tn,fn,precision:tp+fp?tp/(tp+fp):0,recall:1,f1:(2*tp+fp+fn)?2*tp/(2*tp+fp+fn):0,fpr:fp+tn?fp/(fp+tn):0}});
  }
  return results;
}
function basePred5(p,need,gs){return O[p].classical.map((c,i)=>{if(c<cSel.threshold)return 0;let low=0;for(let k=0;k<5;k++)if(O[p][names5[k]][i]<gs[k])low++;return low>=need?0:1;});}
const validationResults5=fastZeroFnSearch('validation',vl,[5,4,3,2]);validationResults5.sort((a,b)=>a.metrics.fp-b.metrics.fp);
let stable5=null;for(const c of validationResults5){const pd=basePred5('developmentTest',c.need,c.gs),m=binaryMetrics(dl,pd,.5);if(m.fn===0){stable5={...c,developmentTest:m};break;}}
const jointGraphVoter=stable5?{need:stable5.need,gates:Object.fromEntries(names5.map((n,i)=>[n,stable5.gs[i]])),validation:stable5.metrics,developmentTest:stable5.developmentTest,finalHoldout:binaryMetrics(hl,basePred5('holdout',stable5.need,stable5.gs),.5),improvesOverBaseline:(stable5.metrics.fp+stable5.developmentTest.fp)<(stable.validation.fp+stable.developmentTest.fp)}:{found:false,note:'no 5-voter joint-gate combination kept validation AND development at FN=0 with lower combined FP than the frozen 4-voter baseline; baseline retained'};
console.log(JSON.stringify({protocol:'FINAL_THREE_STAGE_GRAPH_VETO_PLUS_JOINT_SEARCH',boundaries:split.boundaries,basePolicy:{validation:stable.validation,developmentTest:stable.developmentTest},fpDiscriminator:{threshold:chosen.threshold,validation:chosen.validation,developmentTest:chosen.developmentTest,finalHoldout},graphVetoStage3:{threshold:chosenGraph.threshold,validation:chosenGraph.validation,developmentTest:chosenGraph.developmentTest,finalHoldout:finalHoldoutGraph},graphStandalone,jointGraphVoter,integrity:{holdoutUsedForTraining:false,holdoutUsedForSelection:false,selectionRequiresZeroFnOnValidationAndDevelopment:true,graphNeighborLabelsRestrictedToTrain:true,jointSearchIndependentOfFrozenBaseline:true}},null,2));
