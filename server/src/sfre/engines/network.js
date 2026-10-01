import { makeResult, failed, STATUS, CALIBRATION, coverageOf } from '../core/result.js';

const ENGINE = 'network';

/** Eigenvector centrality of a symmetric non-negative matrix via power iteration from the uniform vector (deterministic). */
export function eigenvectorCentrality(A, { maxIter = 1000, tol = 1e-12 } = {}) {
  const n = A.length;
  let v = new Array(n).fill(1 / Math.sqrt(n));
  let lambda = 0; let converged = false;
  for (let it = 0; it < maxIter; it++) {
    const w = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) w[i] += A[i][j] * v[j];
    const norm = Math.sqrt(w.reduce((s, x) => s + x * x, 0));
    if (!(norm > 0)) return { vector: null, converged: false, lambda: 0 };
    const next = w.map((x) => x / norm);
    const diff = Math.sqrt(next.reduce((s, x, i) => s + (x - v[i]) ** 2, 0));
    v = next; lambda = norm;
    if (diff < tol) { converged = true; break; }
  }
  return { vector: v, converged, lambda };
}

/** overlapValue = result.value of overlapMatrix(); exposures = counterparty matrix X (null = UNOBSERVED). */
export function analyzeNetwork({ ids, overlap, exposures = null }) {
  const n = ids.length;
  if (!overlap || overlap.length !== n) return failed(ENGINE, 'M08.network', 'overlap matrix size mismatch');
  const A = overlap.map((row, i) => row.map((x, j) => (i === j ? 0 : x)));
  const degree = A.map((row) => row.reduce((s, x) => s + x, 0));
  const ev = eigenvectorCentrality(A);
  let cpty = null; const unobserved = [];
  if (exposures) {
    cpty = ids.map((id, i) => {
      let total = 0; let unknown = 0;
      for (let j = 0; j < n; j++) { if (i === j) continue; const x = exposures[i][j]; if (x === null || x === undefined) { unknown++; unobserved.push(`exposure:${id}->${ids[j]}`); } else total += x; }
      return { id, observedExposure: total, unobservedCount: unknown };
    });
  }
  return makeResult({
    engine: ENGINE, modelId: 'M08.network', status: !ev.converged ? STATUS.MODEL_UNCERTAIN : unobserved.length ? STATUS.INSUFFICIENT_OBSERVABILITY : STATUS.MEASURED,
    value: { ids, weightedDegree: degree, eigenvectorCentrality: ev.vector, spectralRadius: ev.lambda, counterparty: cpty },
    coverage: coverageOf(1, 1), unobserved, calibration: CALIBRATION.UNCALIBRATED, parameters: {},
    notes: ev.converged ? [] : ['power iteration did not converge (reducible/degenerate graph)'],
  });
}
