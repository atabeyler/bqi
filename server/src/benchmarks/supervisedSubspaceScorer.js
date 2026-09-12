function sigmoid(x) { return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x)))); }

// Deliberately uses a deterministic feature subspace instead of all columns.
// This creates a supervised voter with different errors from the full linear model.
export function createBalancedSubspaceScorer(trainPart, opts = {}) {
  const rows = [];
  for (const sample of trainPart.samples) {
    const label = trainPart.labels.get(sample.id) || 'unknown';
    if (label === 'unknown') continue;
    rows.push({ x: sample.features.map(Number), y: label === 'illicit' ? 1 : 0 });
  }
  if (!rows.length) throw new Error('no known labeled training rows');
  const fullWidth = Math.max(...rows.map(r => r.x.length));
  // Odd-indexed columns plus every fifth even column: deterministic, broad, decorrelated view.
  const cols = [];
  for (let j = 0; j < fullWidth; j++) if ((j % 2 === 1) || (j % 10 === 0)) cols.push(j);
  const width = cols.length;
  const mean = new Float64Array(width), variance = new Float64Array(width);
  for (const r of rows) for (let k=0;k<width;k++) mean[k] += Number.isFinite(r.x[cols[k]]) ? r.x[cols[k]] : 0;
  for (let k=0;k<width;k++) mean[k] /= rows.length;
  for (const r of rows) for (let k=0;k<width;k++) { const v=Number.isFinite(r.x[cols[k]])?r.x[cols[k]]:0; const d=v-mean[k]; variance[k]+=d*d; }
  const scale=new Float64Array(width); for(let k=0;k<width;k++) scale[k]=Math.sqrt(variance[k]/Math.max(1,rows.length-1))||1;
  const positives=rows.reduce((n,r)=>n+r.y,0), negatives=rows.length-positives;
  const posWeight=positives?rows.length/(2*positives):1, negWeight=negatives?rows.length/(2*negatives):1;
  const weights=new Float64Array(width); let bias=0;
  const epochs=opts.epochs??45, lr=opts.learningRate??0.07, l2=opts.l2??3e-4;
  for(let epoch=0;epoch<epochs;epoch++){
    const grad=new Float64Array(width); let gb=0;
    for(const r of rows){ let z=bias; for(let k=0;k<width;k++){const v=Number.isFinite(r.x[cols[k]])?r.x[cols[k]]:0; z+=weights[k]*((v-mean[k])/scale[k]);} const p=sigmoid(z), cw=r.y?posWeight:negWeight, err=cw*(p-r.y); gb+=err; for(let k=0;k<width;k++){const v=Number.isFinite(r.x[cols[k]])?r.x[cols[k]]:0; grad[k]+=err*((v-mean[k])/scale[k]);}}
    const step=lr/rows.length; bias-=step*gb; for(let k=0;k<width;k++) weights[k]-=step*(grad[k]+l2*rows.length*weights[k]);
  }
  return async sample => { let z=bias; for(let k=0;k<width;k++){const v=Number(sample.features[cols[k]]); z+=weights[k]*(((Number.isFinite(v)?v:0)-mean[k])/scale[k]);} return sigmoid(z); };
}
