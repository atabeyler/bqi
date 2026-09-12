import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

// Regression coverage: analysis.js's /generate response builds `fraud` from
// an explicit field whitelist. When fraud_detection.py gained
// hardwareVerification/ibmDiagnostic (the swap-test IBM hardware
// verification for the top-risk vs. most-typical transaction pair), that
// whitelist wasn't updated -- confirmed live, a real IBM hardware run never
// showed up in the API response's `fraud` field, only inside the report's
// markdown text.

const generateAnalysisMock = vi.fn();
const computeFraudRiskScoresMock = vi.fn();
const mergeFraudResultsMock = vi.fn(() => '');
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
  isFraudCategory: (category) => category === 'bddk' || category === 'btk',
  getCategoryGroup: () => 'compliance',
  CATEGORY_GROUP_SOURCES: { compliance: { local: [], international: [] } },
}));
vi.mock('../services/docx.js', () => ({ generateReportDocx: (...args) => generateReportDocxMock(...args) }));
vi.mock('../services/pdf.js', () => ({ generateReportPdf: (...args) => generateReportPdfMock(...args) }));
vi.mock('../services/email.js', () => ({ sendAnalysisReport: vi.fn(async () => {}) }));
vi.mock('../db/client.js', () => ({ isDbConfigured: () => false, getDb: () => { throw new Error('not used when isDbConfigured() is false'); } }));
vi.mock('../db/schema.js', () => ({ analyses: {}, messages: {} }));
vi.mock('../services/quantum.js', () => ({
  computeQuantumProbabilities: vi.fn(), mergeQuantumResults: vi.fn(),
  isIbmHardwareConfigured: () => false, verifyScenarioHardwareAsync: vi.fn(), buildScenarioHardwareSection: vi.fn(() => ''),
}));
vi.mock('../services/fraudDetection.js', () => ({
  computeFraudRiskScores: (...args) => computeFraudRiskScoresMock(...args),
  mergeFraudResults: (...args) => mergeFraudResultsMock(...args),
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

const FRAUD_CONTENT = `## İŞLEM KAYITLARI
| ID | Tutar | Saat | Sıklık | Yeni Taraf | Sınır Ötesi |
|---|---|---|---|---|---|
| TXN-001 | 15000 | 3 | 4 | 1 | 0 |
| TXN-002 | 500 | 14 | 1 | 0 | 0 |
| TXN-003 | 920000 | 2 | 15 | 1 | 1 |
`;

beforeEach(() => {
  vi.clearAllMocks();
  generateAnalysisMock.mockResolvedValue({ content: FRAUD_CONTENT, provider: 'Test Provider' });
  mergeFraudResultsMock.mockReturnValue('');
});

describe('POST /api/analysis/generate -- fraud hardwareVerification visibility', () => {
  it('surfaces hardwareVerification/ibmDiagnostic on the fraud field when a swap test ran on IBM hardware', async () => {
    computeFraudRiskScoresMock.mockResolvedValue({
      backend: 'qiskit-statevector-kernel', qubits: 5, circuitDepth: 12, circuitDiagram: '',
      transactionCount: 3, flaggedCount: 1,
      transactions: [
        { id: 'TXN-003', amount: 920000, hour: 2, frequency: 15, newCounterparty: 1, crossBorder: 1, riskScore: 100, flagged: true },
      ],
      hardwareVerification: {
        backend: 'ibm_marrakesh', shots: 2048,
        pair: { a: 'TXN-003', b: 'TXN-002' },
        exactFidelity: 0.0979, measuredFidelity: 0.086,
      },
      ibmDiagnostic: 'succeeded on ibm_marrakesh',
    });
    const app = buildApp();
    const res = await request(app)
      .post('/api/analysis/generate')
      .set('Authorization', `Bearer ${token()}`)
      .send({ category: 'btk', title: 'Test', prompt: 'test prompt', quantumMode: true });

    expect(res.status).toBe(200);
    expect(res.body.fraud.hardwareVerification).toMatchObject({ backend: 'ibm_marrakesh', pair: { a: 'TXN-003', b: 'TXN-002' } });
    expect(res.body.fraud.ibmDiagnostic).toBe('succeeded on ibm_marrakesh');
  });

  it('leaves hardwareVerification/ibmDiagnostic null when IBM is not configured', async () => {
    computeFraudRiskScoresMock.mockResolvedValue({
      backend: 'qiskit-statevector-kernel', qubits: 5, circuitDepth: 12, circuitDiagram: '',
      transactionCount: 3, flaggedCount: 1,
      transactions: [
        { id: 'TXN-003', amount: 920000, hour: 2, frequency: 15, newCounterparty: 1, crossBorder: 1, riskScore: 100, flagged: true },
      ],
      hardwareVerification: null,
      ibmDiagnostic: 'not configured (IBM_QUANTUM_TOKEN/IBM_QUANTUM_INSTANCE unset)',
    });
    const app = buildApp();
    const res = await request(app)
      .post('/api/analysis/generate')
      .set('Authorization', `Bearer ${token()}`)
      .send({ category: 'bddk', title: 'Test', prompt: 'test prompt', quantumMode: true });

    expect(res.status).toBe(200);
    expect(res.body.fraud.hardwareVerification).toBeNull();
    expect(res.body.fraud.ibmDiagnostic).toMatch(/not configured/);
  });
});
