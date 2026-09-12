import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const generateAnalysisMock = vi.fn();
const computeQuantumProbabilitiesMock = vi.fn();
const generateReportDocxMock = vi.fn(async () => Buffer.from('docx'));
const generateReportPdfMock = vi.fn(async () => Buffer.from('pdf'));

vi.mock('../services/ai.js', () => ({
  generateAnalysis: (...args) => generateAnalysisMock(...args),
  generateAnalysisWithVision: vi.fn(),
  streamConsultationText: vi.fn(),
  getSystemPromptForCategory: () => 'sys',
  getQuantumSystemPrompt: () => 'sys-quantum',
  getScenarioDeepDivePrompt: () => 'sys-scenario',
  getConsultationPrompt: () => 'sys-consult',
  getStatus: () => ({ claude: false, gemini: false, openai: false }),
  isFraudCategory: () => false,
  getCategoryGroup: () => 'defense',
  CATEGORY_GROUP_SOURCES: { defense: { local: [], international: [] } },
}));
vi.mock('../services/docx.js', () => ({ generateReportDocx: (...args) => generateReportDocxMock(...args) }));
vi.mock('../services/pdf.js', () => ({ generateReportPdf: (...args) => generateReportPdfMock(...args) }));
vi.mock('../services/email.js', () => ({ sendAnalysisReport: vi.fn(async () => {}) }));
vi.mock('../db/client.js', () => ({ isDbConfigured: () => false, getDb: () => { throw new Error('not used when isDbConfigured() is false'); } }));
vi.mock('../db/schema.js', () => ({ analyses: {}, messages: {} }));
vi.mock('../services/quantum.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    computeQuantumProbabilities: (...args) => computeQuantumProbabilitiesMock(...args),
  };
});
vi.mock('../services/fraudDetection.js', () => ({
  computeFraudRiskScores: vi.fn(), mergeFraudResults: vi.fn(),
  verifyFraudHardwareAsync: vi.fn(), buildFraudHardwareSection: vi.fn(() => ''),
}));
vi.mock('../services/socket.js', () => ({ broadcastToUser: vi.fn(async () => {}) }));
vi.mock('../services/portfolioOptimizer.js', () => ({ computeOptimalAllocation: vi.fn(), mergeOptimizerResults: vi.fn() }));
vi.mock('../services/transactionSource.js', () => ({ parseTransactionFile: vi.fn() }));
vi.mock('../services/scenarioDataSource.js', () => ({ parseScenarioFile: vi.fn(), parseOptimizationFile: vi.fn() }));
vi.mock('../services/tableParsing.js', () => ({ sheetToText: vi.fn() }));
vi.mock('../services/weather.js', () => ({ isWeatherQuery: () => false, getLiveWeatherReply: vi.fn() }));
vi.mock('../services/webResearch.js', () => ({ researchWeb: vi.fn(), formatResearchContext: vi.fn() }));

const { default: analysisRouter } = await import('./analysis.js');
const { JWT_SECRET } = await import('../lib/jwtSecret.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/analysis', analysisRouter);
  return app;
}

function token(userCode = 'BOLD-001') {
  return jwt.sign({ userCode }, JWT_SECRET, { expiresIn: '1h' });
}

const QUANTUM_CONTENT = `## KUANTUM OLASILIK MATRİSİ
| Senaryo | Olasılık | Zaman Ufku | Kritik Tetikleyici |
|---|---|---|---|
| SENARYO-A | %60 | 0-12 ay | tetikleyici A |
| SENARYO-B | %40 | 12-24 ay | tetikleyici B |
`;

beforeEach(() => {
  vi.clearAllMocks();
  generateAnalysisMock.mockResolvedValue({ content: QUANTUM_CONTENT, provider: 'Test Provider' });
});

describe('POST /api/analysis/generate -- quantum failure visibility', () => {
  it('surfaces a quantumWarning (and appends a note to the report) when the circuit computation fails', async () => {
    computeQuantumProbabilitiesMock.mockResolvedValue(null); // simulates a broken/missing Qiskit worker
    const app = buildApp();
    const res = await request(app)
      .post('/api/analysis/generate')
      .set('Authorization', `Bearer ${token()}`)
      .send({ category: 'enerji', title: 'Test', prompt: 'test prompt', quantumMode: true });

    expect(res.status).toBe(200);
    expect(res.body.quantumWarning).toMatch(/başarısız/);
    expect(res.body.content).toContain(res.body.quantumWarning);
  });

  it('surfaces a quantumWarning when the AI response has no parseable scenario matrix at all', async () => {
    generateAnalysisMock.mockResolvedValue({ content: 'Bu rapor bir senaryo tablosu içermiyor.', provider: 'Test Provider' });
    const app = buildApp();
    const res = await request(app)
      .post('/api/analysis/generate')
      .set('Authorization', `Bearer ${token()}`)
      .send({ category: 'enerji', title: 'Test', prompt: 'test prompt', quantumMode: true });

    expect(res.status).toBe(200);
    expect(res.body.quantumWarning).toMatch(/senaryo matrisi bulunamadığından/);
    expect(computeQuantumProbabilitiesMock).not.toHaveBeenCalled();
  });

  it('does not set quantumWarning when the circuit computation succeeds', async () => {
    computeQuantumProbabilitiesMock.mockResolvedValue({
      backend: 'qiskit-aer-simulator', qubits: 2, shots: 4096, batches: 1, circuitDepth: 8,
      scenarios: [
        { id: 'SENARYO-A', llmEstimate: 60, quantumProbability: 58, quantumStdDev: 1, quantumRangeLow: 57, quantumRangeHigh: 59 },
        { id: 'SENARYO-B', llmEstimate: 40, quantumProbability: 42, quantumStdDev: 1, quantumRangeLow: 41, quantumRangeHigh: 43 },
      ],
    });
    const app = buildApp();
    const res = await request(app)
      .post('/api/analysis/generate')
      .set('Authorization', `Bearer ${token()}`)
      .send({ category: 'enerji', title: 'Test', prompt: 'test prompt', quantumMode: true });

    expect(res.status).toBe(200);
    expect(res.body.quantumWarning).toBeNull();
    expect(res.body.quantum).toMatchObject({ backend: 'qiskit-aer-simulator', qubits: 2 });
  });

  it('surfaces hardwareVerification/ibmDiagnostic on the quantum field of the /generate response', async () => {
    // Regression test: these were computed by scenario_quantum.py and
    // present on computeQuantumProbabilities()'s resolved value, but the
    // /generate route's response builds `quantum` from an explicit field
    // whitelist that didn't include them -- so a real IBM hardware run
    // never showed up in the API response here, only inside quantum-status
    // (a separate endpoint) and buried in the report's markdown text.
    computeQuantumProbabilitiesMock.mockResolvedValue({
      backend: 'qiskit-aer-simulator', qubits: 2, shots: 4096, batches: 1, circuitDepth: 8,
      scenarios: [
        { id: 'SENARYO-A', llmEstimate: 60, quantumProbability: 58, quantumStdDev: 1, quantumRangeLow: 57, quantumRangeHigh: 59 },
        { id: 'SENARYO-B', llmEstimate: 40, quantumProbability: 42, quantumStdDev: 1, quantumRangeLow: 41, quantumRangeHigh: 43 },
      ],
      hardwareVerification: { backend: 'ibm_marrakesh', shots: 4095, scenarios: [{ id: 'SENARYO-A', quantumProbability: 61.2 }] },
      ibmDiagnostic: 'succeeded on ibm_marrakesh',
    });
    const app = buildApp();
    const res = await request(app)
      .post('/api/analysis/generate')
      .set('Authorization', `Bearer ${token()}`)
      .send({ category: 'enerji', title: 'Test', prompt: 'test prompt', quantumMode: true });

    expect(res.status).toBe(200);
    expect(res.body.quantum.hardwareVerification).toMatchObject({ backend: 'ibm_marrakesh' });
    expect(res.body.quantum.ibmDiagnostic).toBe('succeeded on ibm_marrakesh');
  });

  it('forwards the ALL_AI_PROVIDERS_FAILED error code so the client can show a localized message', async () => {
    // Regression test: this error's message is Turkish-only and isn't
    // routed through the client's i18n system -- without forwarding `code`,
    // the UI showed it raw regardless of the user's selected app language.
    const err = new Error('Tüm AI sağlayıcılar başarısız: []');
    err.code = 'ALL_AI_PROVIDERS_FAILED';
    generateAnalysisMock.mockRejectedValue(err);
    const app = buildApp();
    const res = await request(app)
      .post('/api/analysis/generate')
      .set('Authorization', `Bearer ${token()}`)
      .send({ category: 'enerji', title: 'Test', prompt: 'test prompt', quantumMode: false });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('ALL_AI_PROVIDERS_FAILED');
  });

  it('does not set quantumWarning when quantum mode is off', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/analysis/generate')
      .set('Authorization', `Bearer ${token()}`)
      .send({ category: 'enerji', title: 'Test', prompt: 'test prompt', quantumMode: false });

    expect(res.status).toBe(200);
    expect(res.body.quantumWarning).toBeNull();
    expect(computeQuantumProbabilitiesMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/analysis/quantum-status -- unauthenticated Python/Qiskit worker health check', () => {
  it('reports ok:true with backend info when the Qiskit worker responds', async () => {
    computeQuantumProbabilitiesMock.mockResolvedValue({ backend: 'qiskit-aer-simulator', qubits: 2, shots: 4096, scenarios: [] });
    const app = buildApp();
    const res = await request(app).get('/api/analysis/quantum-status');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, backend: 'qiskit-aer-simulator', qubits: 2, hardwareVerification: null, ibmDiagnostic: null });
  });

  it('reports ok:false when the Qiskit worker fails (deployment broken)', async () => {
    computeQuantumProbabilitiesMock.mockResolvedValue(null);
    const app = buildApp();
    const res = await request(app).get('/api/analysis/quantum-status');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, backend: null, qubits: null, hardwareVerification: null, ibmDiagnostic: null });
  });

  it('surfaces hardwareVerification when IBM_QUANTUM_TOKEN/INSTANCE are configured and a real hardware run succeeded', async () => {
    // Regression guard: the simulator run's top-level "backend" is always
    // "qiskit-aer-simulator" by design (see scenario_quantum.py), so it
    // can never be used to tell whether real IBM hardware ran --
    // hardwareVerification is the only field that reflects that.
    computeQuantumProbabilitiesMock.mockResolvedValue({
      backend: 'qiskit-aer-simulator', qubits: 2, shots: 4096, scenarios: [],
      hardwareVerification: { backend: 'ibm_torino', shots: 4096, scenarios: [{ id: 'health-check', quantumProbability: 51.2 }] },
    });
    const app = buildApp();
    const res = await request(app).get('/api/analysis/quantum-status');

    expect(res.status).toBe(200);
    expect(res.body.hardwareVerification).toMatchObject({ backend: 'ibm_torino' });
  });

  it('surfaces ibmDiagnostic explaining why hardware was not used, when IBM is configured but the attempt failed', async () => {
    // Without this, "hardwareVerification: null" is indistinguishable from
    // "not configured" -- ibmDiagnostic carries the actual reason (bad
    // token/CRN, queue timeout, no available backend, etc.) surfaced from
    // _ibm_backend.py's LAST_IBM_ERROR.
    computeQuantumProbabilitiesMock.mockResolvedValue({
      backend: 'qiskit-aer-simulator', qubits: 2, shots: 4096, scenarios: [],
      hardwareVerification: null,
      ibmDiagnostic: "configured but failed: IBMApiError: Instance CRN not found or access denied",
    });
    const app = buildApp();
    const res = await request(app).get('/api/analysis/quantum-status');

    expect(res.status).toBe(200);
    expect(res.body.ibmDiagnostic).toMatch(/configured but failed/);
  });

  it('requires no authentication', async () => {
    computeQuantumProbabilitiesMock.mockResolvedValue(null);
    const app = buildApp();
    const res = await request(app).get('/api/analysis/quantum-status');
    expect(res.status).not.toBe(401);
  });
});
