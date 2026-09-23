import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const generateAnalysisMock = vi.fn(async () => ({ provider: 'Claude (Anthropic)', content: 'ok', usage: null }));
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
vi.mock('../services/webResearch.js', () => ({ researchWeb: vi.fn(), formatResearchContext: vi.fn() }));

const { default: analysisRouter } = await import('./analysis.js');
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

describe('POST /generate — priority/depth request fields', () => {
  it('defaults to normal priority and standart depth when omitted', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/analysis/generate')
      .set('Authorization', `Bearer ${token({ role: 'analyst' })}`)
      .send({ category: 'ekonomi', prompt: 'test' });
    expect(res.status).toBe(200);
    expect(res.body.priority).toBe('normal');
    expect(res.body.depth).toBe('standart');
  });

  it('accepts a valid priority/depth pair', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/analysis/generate')
      .set('Authorization', `Bearer ${token({ role: 'analyst' })}`)
      .send({ category: 'ekonomi', prompt: 'test', priority: 'kritik', depth: 'hizli' });
    expect(res.status).toBe(200);
    expect(res.body.priority).toBe('kritik');
    expect(res.body.depth).toBe('hizli');
  });

  it('falls back to defaults for an unrecognized priority/depth value instead of erroring', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/analysis/generate')
      .set('Authorization', `Bearer ${token({ role: 'analyst' })}`)
      .send({ category: 'ekonomi', prompt: 'test', priority: 'not-a-real-priority', depth: 'not-a-real-depth' });
    expect(res.status).toBe(200);
    expect(res.body.priority).toBe('normal');
    expect(res.body.depth).toBe('standart');
  });
});

describe('POST /generate — classification access control', () => {
  // TEMPORARILY skipped: every category (bddk included) defaults to
  // INTERNAL right now, so there's no CONFIDENTIAL category left to prove
  // a viewer is blocked from. See classifyData's comment for the revert;
  // this test's body is unchanged.
  it.skip('blocks a viewer-role user from generating a CONFIDENTIAL category (bddk)', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/analysis/generate')
      .set('Authorization', `Bearer ${token({ role: 'viewer' })}`)
      .send({ category: 'bddk', prompt: 'test' });
    expect(res.status).toBe(403);
    expect(generateAnalysisMock).not.toHaveBeenCalled();
  });

  it('allows an analyst-role user to generate any category', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/analysis/generate')
      .set('Authorization', `Bearer ${token({ role: 'analyst' })}`)
      .send({ category: 'bddk', prompt: 'test' });
    expect(res.status).toBe(200);
    expect(generateAnalysisMock).toHaveBeenCalled();
  });

  // Savunma is temporarily INTERNAL (see above), so a viewer -- normally
  // blocked from CONFIDENTIAL -- can generate it during this window. This
  // is a deliberate, temporary widening for HAVELSAN presentation prep
  // (user-confirmed: no other real users on this deployment right now),
  // not an oversight. Revert alongside classifyData's own revert note.
  it('TEMP: viewer-role can generate savunma while it is INTERNAL', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/analysis/generate')
      .set('Authorization', `Bearer ${token({ role: 'viewer' })}`)
      .send({ category: 'savunma', prompt: 'test' });
    expect(res.status).toBe(200);
    expect(generateAnalysisMock).toHaveBeenCalled();
  });

  it('allows a legacy isAdmin token (no role claim) through regardless of classification', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/analysis/generate')
      .set('Authorization', `Bearer ${token({ isAdmin: true })}`)
      .send({ category: 'savunma', prompt: 'test', dataClassification: 'RESTRICTED' });
    expect(res.status).toBe(200);
  });

  it('blocks an analyst-role user from an explicit RESTRICTED override even on an otherwise-INTERNAL category', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/analysis/generate')
      .set('Authorization', `Bearer ${token({ role: 'analyst' })}`)
      .send({ category: 'ekonomi', prompt: 'test', dataClassification: 'RESTRICTED' });
    expect(res.status).toBe(403);
    expect(generateAnalysisMock).not.toHaveBeenCalled();
  });

  it('allows a viewer-role user through for an INTERNAL category', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/analysis/generate')
      .set('Authorization', `Bearer ${token({ role: 'viewer' })}`)
      .send({ category: 'ekonomi', prompt: 'test' });
    expect(res.status).toBe(200);
  });
});

describe('POST /scenario-deep-dive — classification access control', () => {
  // TEMPORARILY skipped -- see classifyData's comment for the revert.
  it.skip('blocks a viewer-role user from a CONFIDENTIAL category', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/analysis/scenario-deep-dive')
      .set('Authorization', `Bearer ${token({ role: 'viewer' })}`)
      .send({ category: 'bddk', scenarioId: 'SENARYO-A', scenarioSummary: 'test' });
    expect(res.status).toBe(403);
    expect(generateAnalysisMock).not.toHaveBeenCalled();
  });

  it('allows an analyst-role user through for a CONFIDENTIAL category', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/analysis/scenario-deep-dive')
      .set('Authorization', `Bearer ${token({ role: 'analyst' })}`)
      .send({ category: 'bddk', scenarioId: 'SENARYO-A', scenarioSummary: 'test' });
    expect(res.status).toBe(200);
  });
});
