function sigmoid(x){return 1/(1+Math.exp(-Math.max(-30,Math.min(30,x))));}
export function createTemporalRegimeScorer(trainPart,opts={}){
 const rows=[];for(const s of trainPart.samples){const l=trainPart.labels.get(s.id)||'unknown';if(l==='unknown')continue;rows.push({x:Array.from(s.features,Number),t:Number(s.timeStep)||0,y:l==='illicit'?1:0});}
 if(!rows.length)throw new Error('no labeled training rows');
 const baseWidth=Math.max(...rows.map(r=>r.x.length));
 const enrich=r=>{const x=r.x.slice();let abs=0,sq=0,max=0;for(const v0 of r.x){const v=Number.isFinite(v0)?v0:0;abs+=Math.abs(v);sq+=v*v;max=Math.max(max,Math.abs(v));}x.push(r.t,r.t*r.t/100,abs/baseWidth,Math.sqrt(sq/baseWidth),max);return x;};
 const X=rows.map(enrich),w=X[0].length,mean=new Float64Array(w),varr=new Float64Array(w);
 for(const x of X)for(let j=0;j<w;j++)mean[j]+=Number.isFinite(x[j])?x[j]:0;for(let j=0;j<w;j++)mean[j]/=X.length;
 for(const x of X)for(let j=0;j<w;j++){const v=Number.isFinite(x[j])?x[j]:0,d=v-mean[j];varr[j]+=d*d;}const scale=new Float64Array(w);for(let j=0;j<w;j++)scale[j]=Math.sqrt(varr[j]/Math.max(1,X.length-1))||1;
 const pos=rows.reduce((n,r)=>n+r.y,0),neg=rows.length-pos,pw=rows.length/(2*Math.max(1,pos)),nw=rows.length/(2*Math.max(1,neg));
 const weights=new Float64Array(w);let bias=0;const epochs=opts.epochs??55,lr=opts.learningRate??.06,l2=opts.l2??5e-4;
 for(let e=0;e<epochs;e++){const g=new Float64Array(w);let gb=0;for(let i=0;i<X.length;i++){let z=bias;for(let j=0;j<w;j++)z+=weights[j]*(((Number.isFinite(X[i][j])?X[i][j]:0)-mean[j])/scale[j]);const p=sigmoid(z),cw=rows[i].y?pw:nw,err=cw*(p-rows[i].y);gb+=err;for(let j=0;j<w;j++)g[j]+=err*(((Number.isFinite(X[i][j])?X[i][j]:0)-mean[j])/scale[j]);}const step=lr/X.length;bias-=step*gb;for(let j=0;j<w;j++)weights[j]-=step*(g[j]+l2*X.length*weights[j]);}
 return async s=>{const x=enrich({x:Array.from(s.features,Number),t:Number(s.timeStep)||0});let z=bias;for(let j=0;j<w;j++)z+=weights[j]*(((Number.isFinite(x[j])?x[j]:0)-mean[j])/scale[j]);return sigmoid(z);};
}
