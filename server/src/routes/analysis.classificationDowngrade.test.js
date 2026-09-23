import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

// AQ — classification downgrade (P0): a client-supplied dataClassification
// must only ever RAISE the category-derived classification, never lower
// it. These tests hit the real routes end-to-end (through classifyData +
// canAccessClassification) proving a low-privileged (viewer) caller cannot
// strip CONFIDENTIAL protection off a sensitive category by asking for
// dataClassification: 'PUBLIC'.

const generateAnalysisMock = vi.fn(async () => ({ provider: 'Claude (Anthropic)', content: 'ok', usage: null }));
const generateReportDocxMock = vi.fn(async () => Buffer.from('docx'));
const generateReportPdfMock = vi.fn(async () => Buffer.from('pdf'));
const generateCoaComparisonMock = vi.fn(async () => ({ comparison: 'ok', provider: 'Claude (Anthropic)' }));
const streamConsultationTextMock = vi.fn(async () => ({ provider: 'Claude (Anthropic)', content: 'ok' }));

vi.mock('../services/ai.js', () => ({
  generateAnalysis: (...args) => generateAnalysisMock(...args),
  generateAnalysisWithVision: vi.fn(),
  streamConsultationText: (...args) => streamConsultationTextMock(...args),
  getSystemPromptForCategory: () => 'sys',
  getQuantumSystemPrompt: () => 'sys-quantum',
  getScenarioDeepDivePrompt: () => 'sys-scenario',
  getConsultationPrompt: () => 'sys-consult',
  getStatus: () => ({ claude: false, gemini: false, openai: false }),
  isFraudCategory: () => false,
  getCategoryGroup: () => 'defense',
  CATEGORY_GROUP_SOURCES: { defense: { local: [], international: [] } },
  wrapUntrustedEvidence: (label, content) => `--- UNTRUSTED EVIDENCE START --- (${label})\n${content}\n--- UNTRUSTED EVIDENCE END ---`,
}));
vi.mock('../services/coaComparison.js', () => ({ generateCoaComparison: (...args) => generateCoaComparisonMock(...args) }));
vi.mock('../services/docx.js', () => ({ generateReportDocx: (...args) => generateReportDocxMock(...args) }));
vi.mock('../services/pdf.js', () => ({ generateReportPdf: (...args) => generateReportPdfMock(...args) }));
vi.mock('../services/email.js', () => ({ sendAnalysisReport: vi.fn(async () => {}) }));
vi.mock('../db/client.js', () => ({ isDbConfigured: () => false, getDb: () => { throw new Error('not used when isDbConfigured() is false'); } }));
vi.mock('../db/schema.js', () => ({ analyses: {}, messages: {} }));
vi.mock('../services/quantum.js', () => ({
  computeQuantumProbabilities: vi.fn(async () => null),
  isIbmHardwareConfigured: () => false,
}));
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
vi.mock('../services/webResearch.js', () => ({ researchWeb: vi.fn(async () => []), formatResearchContext: vi.fn(() => '') }));

const { default: analysisRouter } = await import('./analysis.js');
const { classifyData } = await import('../services/decisionIntelligence.js');
const { JWT_SECRET } = await import('../lib/jwtSecret.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/analysis', analysisRouter);
  return app;
}

function token(claims = {}) {
  return jwt.sign({ userCode: 'BOLD-001', ...claims }, JWT_SECRET, { expiresIn: '1h' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('classifyData — requested classification can only raise, never lower', () => {
  it('ignores a downgrade attempt on a CONFIDENTIAL category', () => {
    expect(classifyData('savunma', 'PUBLIC')).toBe('CONFIDENTIAL');
    expect(classifyData('bddk', 'INTERNAL')).toBe('CONFIDENTIAL');
  });

  it('still allows raising a category above its default', () => {
    expect(classifyData('ekonomi', 'RESTRICTED')).toBe('RESTRICTED');
    expect(classifyData('savunma', 'RESTRICTED')).toBe('RESTRICTED');
  });

  it('lets an uncategorized request set classification freely (no floor to raise above)', () => {
    expect(classifyData(null, 'PUBLIC')).toBe('PUBLIC');
    expect(classifyData(null, 'RESTRICTED')).toBe('RESTRICTED');
  });
});

describe('POST /generate — downgrade attempt is still blocked by RBAC', () => {
  it('a viewer cannot bypass CONFIDENTIAL protection on "savunma" by requesting dataClassification: PUBLIC', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/analysis/generate')
      .set('Authorization', `Bearer ${token({ role: 'viewer' })}`)
      .send({ category: 'savunma', prompt: 'test', dataClassification: 'PUBLIC' });
    expect(res.status).toBe(403);
    expect(generateAnalysisMock).not.toHaveBeenCalled();
  });
});

describe('POST /scenario-deep-dive — downgrade attempt is still blocked by RBAC', () => {
  it('a viewer cannot bypass CONFIDENTIAL protection on "bddk" by requesting dataClassification: PUBLIC', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/analysis/scenario-deep-dive')
      .set('Authorization', `Bearer ${token({ role: 'viewer' })}`)
      .send({ category: 'bddk', scenarioId: 'SENARYO-A', scenarioSummary: 'test', dataClassification: 'PUBLIC' });
    expect(res.status).toBe(403);
    expect(generateAnalysisMock).not.toHaveBeenCalled();
  });
});

describe('POST /coa-compare — downgrade attempt is still blocked by RBAC', () => {
  it('a viewer cannot bypass CONFIDENTIAL protection on "saldiri" by requesting dataClassification: PUBLIC', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/analysis/coa-compare')
      .set('Authorization', `Bearer ${token({ role: 'viewer' })}`)
      .send({
        topic: 'test', category: 'saldiri', dataClassification: 'PUBLIC',
        options: [{ id: '1', title: 'A' }, { id: '2', title: 'B' }],
      });
    expect(res.status).toBe(403);
    expect(generateCoaComparisonMock).not.toHaveBeenCalled();
  });

  it('still allows an analyst through for the same category (positive control)', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/analysis/coa-compare')
      .set('Authorization', `Bearer ${token({ role: 'analyst' })}`)
      .send({
        topic: 'test', category: 'saldiri',
        options: [{ id: '1', title: 'A' }, { id: '2', title: 'B' }],
      });
    expect(res.status).toBe(200);
    expect(generateCoaComparisonMock).toHaveBeenCalled();
  });
});
