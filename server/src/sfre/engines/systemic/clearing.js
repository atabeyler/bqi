/**
 * Clearing of a liability network (Eisenberg & Noe 2001; Rogers & Veraart 2013 with bankruptcy costs).
 *  n entities; ext[i] = external (non-network) asset value; extLiab[i] = liabilities to creditors outside the network;
 *  edges: [{c: creditor idx, d: debtor idx, amount}] with KNOWN amounts only (callers exclude unobserved edges and report them).
 * Solved by monotone fixed-point iteration from the full-payment vector downward (greatest clearing vector):
 *   p_i = Lbar_i                       if ext_i + sum_j pi_ji p_j >= Lbar_i
 *   p_i = alpha*ext_i + beta*sum_j pi_ji p_j   otherwise
 * Defaults only ever get added along the iteration, so each entity has a well-defined default round ("wave").
 * Independent reference (default-set + Gaussian elimination) lives in sfre/crosscheck/reference_systemic.py.
 */
export function clearNetwork({ n, ext, extLiab, edges, alpha = 1, beta = 1, maxIter = 50000, tol = 1e-12 }) {
  const Lbar = new Array(n).fill(0);
  for (let i = 0; i < n; i++) Lbar[i] = extLiab[i] || 0;
  for (const e of edges) Lbar[e.d] += e.amount;
  const incoming = Array.from({ length: n }, () => []); // creditor i -> [{d, share}]
  for (const e of edges) if (Lbar[e.d] > 0 && e.amount > 0) incoming[e.c].push({ d: e.d, share: e.amount / Lbar[e.d], amount: e.amount });
  const p = Lbar.slice();
  const defaultIter = new Array(n).fill(-1);
  const scale = Math.max(1, ...Lbar);
  const claimsRecv = (i, pv) => { let s = 0; for (const x of incoming[i]) s += x.share * pv[x.d]; return s; };
  let converged = false; let it = 0;
  for (; it < maxIter; it++) {
    let maxDiff = 0; let newDefault = false;
    const next = new Array(n);
    for (let i = 0; i < n; i++) {
      if (Lbar[i] <= 0) { next[i] = 0; continue; }
      const recv = claimsRecv(i, p); const assets = ext[i] + recv;
      if (assets >= Lbar[i] - tol * scale) next[i] = Lbar[i];
      else { next[i] = alpha * ext[i] + beta * recv; if (defaultIter[i] < 0) { defaultIter[i] = it; newDefault = true; } }
      maxDiff = Math.max(maxDiff, Math.abs(next[i] - p[i]));
    }
    for (let i = 0; i < n; i++) p[i] = next[i];
    if (!newDefault && maxDiff <= tol * scale) { converged = true; break; }
  }
  // wave index: rank of the distinct iterations in which defaults first appeared (1-based); -1 = solvent
  const iters = [...new Set(defaultIter.filter((x) => x >= 0))].sort((a, b) => a - b);
  const wave = defaultIter.map((x) => (x < 0 ? -1 : iters.indexOf(x) + 1));
  const assetsFinal = new Array(n); const equity = new Array(n); const deadweight = new Array(n);
  for (let i = 0; i < n; i++) {
    assetsFinal[i] = ext[i] + claimsRecv(i, p);
    const isDefault = wave[i] > 0;
    equity[i] = isDefault ? 0 : assetsFinal[i] - Lbar[i];
    deadweight[i] = isDefault ? Math.max(0, assetsFinal[i] - p[i]) : 0;
  }
  return { p, Lbar, wave, defaulted: wave.map((w) => w > 0), waves: iters.length, assets: assetsFinal, equity, deadweight, converged, iterations: it + 1, incoming };
}
