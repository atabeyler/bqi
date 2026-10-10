const BASE_URL = import.meta.env.VITE_BCI_API_URL || 'http://localhost:8081/api/v1';
const TOKEN_KEY = 'bci_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function isLoggedIn() {
  return Boolean(getToken());
}

async function request(path, { method = 'GET', body } = {}) {
  const token = getToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    setToken(null);
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed: ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  pentestAccounts: () => request('/pentest/accounts'),
  createPentestAccount: (body) => request('/pentest/accounts', { method: 'POST', body }),
  revokePentestAccount: (id) => request(`/pentest/accounts/${id}`, { method: 'DELETE' }),
  pentestEngagements: () => request('/pentest/engagements'),
  createPentestEngagement: (body) => request('/pentest/engagements', { method: 'POST', body }),
  revokePentestEngagement: (id) => request(`/pentest/engagements/${id}`, { method: 'DELETE' }),
  pentestResults: (id) => request(`/pentest/results/${id}`),
  pentestReport: (scanJobId) => request('/reports', { method: 'POST', body: { reportType: 'TECHNICAL', scanJobId } }),
  login: (orgSlug, email, password) => request('/auth/login', { method: 'POST', body: { orgSlug, email, password } }),
  me: () => request('/auth/me'),

  securityScore: () => request('/risk/security-score'),
  coverageScore: () => request('/risk/coverage-score'),

  listAssets: (status) => request(status ? `/assets?status=${encodeURIComponent(status)}` : '/assets'),
  createAsset: (asset) => request('/assets', { method: 'POST', body: asset }),
  archiveAsset: (id) => request(`/assets/${id}`, { method: 'PATCH', body: { status: 'ARCHIVED' } }),

  listFindings: () => request('/findings'),
  getFinding: (id) => request(`/findings/${id}`),
  explainFinding: (id) => request(`/findings/${id}/explain`),
  verifyFindingFix: (id) => request(`/findings/${id}/verify-fix`, { method: 'POST' }),
  confirmFinding: (id) => request(`/findings/${id}/confirm`, { method: 'POST' }),
  markFalsePositive: (id) => request(`/findings/${id}/false-positive`, { method: 'POST' }),

  listScopes: () => request('/scopes'),
  createScope: (scope) => request('/scopes', { method: 'POST', body: scope }),
  approveScope: (id) => request(`/scopes/${id}/approve`, { method: 'POST' }),

  listScans: (archived = false) => request(archived ? '/scans?archived=true' : '/scans'),
  getScan: (id) => request(`/scans/${id}`),
  createScan: (scan) => request('/scans', { method: 'POST', body: scan }),
  cancelScan: (id) => request(`/scans/${id}/cancel`, { method: 'POST' }),
  archiveScan: (id) => request(`/scans/${id}/archive`, { method: 'POST' }),
  unarchiveScan: (id) => request(`/scans/${id}/unarchive`, { method: 'POST' }),
  deleteScan: (id) => request(`/scans/${id}`, { method: 'DELETE' }),

  listReports: () => request('/reports'),
  generateReport: (reportType, language = 'en') => request('/reports', { method: 'POST', body: { reportType, language } }),
  getReport: (id) => request(`/reports/${id}`),
  deleteReport: (id) => request(`/reports/${id}`, { method: 'DELETE' }),

  listEngines: () => request('/engines'),
  runEngineHealthCheck: () => request('/engines/health-check', { method: 'POST' }),

  listAudit: () => request('/audit'),

  listQuantumProviders: () => request('/quantum/providers'),
  getQuantumPolicy: () => request('/quantum/policy'),
  setQuantumPolicy: (policy) => request('/quantum/policy', { method: 'PUT', body: policy }),
  runRemediationOptimize: (effortBudget) => request('/quantum/remediation-optimize', { method: 'POST', body: { effortBudget } }),
  listQuantumBenchmarks: () => request('/quantum/benchmarks'),
  listQuantumJobs: () => request('/quantum/jobs'),

  discoverCrypto: (target, port, protocol = 'TLS') => request('/crypto/discover', { method: 'POST', body: { target, protocol, ...(port ? { port } : {}) } }),
  discoverJwtCrypto: (token, label) => request('/crypto/discover/jwt', { method: 'POST', body: { token, ...(label ? { label } : {}) } }),
  listCryptoInventory: () => request('/crypto/inventory'),
  getCbom: () => request('/crypto/cbom'),
  getPqcReadiness: () => request('/crypto/readiness'),

  getKnowledgeGraph: () => request('/graph/knowledge'),
  getDigitalTwin: () => request('/decision/digital-twin'),
  getAiSecurity: () => request('/decision/ai-security'),
  getComplianceAssessment: () => request('/decision/compliance'),
  runCyberDecision: (effortBudget) => request('/decision/recommend', { method: 'POST', body: { effortBudget } }),
  runWhatIfSimulation: (scenario) => request('/decision/simulate', { method: 'POST', body: scenario }),

  analyzeControlledProof: (targetUrl) => request('/controlled-proof/analyze', {
    method: 'POST', body: { targetUrl },
  }),
  listControlledProofHistory: (archived = false) => request(archived ? '/controlled-proof/history?archived=true' : '/controlled-proof/history'),
  getControlledProof: (id) => request(`/controlled-proof/${id}`),
  startControlledPublicProof: (id, durationSeconds) => request(`/controlled-proof/${id}/public-proof/start`, { method: 'POST', body: { durationSeconds } }),
  stopControlledPublicProof: (id) => request(`/controlled-proof/${id}/public-proof/stop`, { method: 'POST' }),
  cancelControlledProof: (id) => request(`/controlled-proof/${id}/cancel`, { method: 'POST' }),
  archiveControlledProof: (id) => request(`/controlled-proof/${id}/archive`, { method: 'POST' }),
  unarchiveControlledProof: (id) => request(`/controlled-proof/${id}/unarchive`, { method: 'POST' }),
  deleteControlledProof: (id) => request(`/controlled-proof/${id}`, { method: 'DELETE' }),
};
