import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import bcrypt from 'bcrypt';

// Full user-facing pipeline, exercised through the REAL Express routes
// (auth.js, analysis.js, history.js, unmodified) with supertest: login ->
// upload a document -> generate an analysis (persisted) -> see it in
// history -> download it as a report. Only the outer edges are faked --
// services/database.js (auth_users, no live Postgres in this sandbox), the
// AI provider and quantum/fraud/portfolio engines (exercised on their own
// by quantum.test.js and quantum/smoke_test.py, not re-run here), and
// docx/pdf rendering (exercised by docx.test.js/pdf.test.js). Everything in
// between -- auth, RBAC, multer upload parsing, the /generate orchestration,
// Drizzle persistence, and the history/export reads -- is the genuine,
// shipped code.

let authUsers;

vi.mock('../services/database.js', () => ({
  query: vi.fn(async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT COUNT(*)::int AS count FROM auth_users')) {
      return { rows: [{ count: authUsers.size }], rowCount: authUsers.size };
    }
    if (s.startsWith('SELECT * FROM auth_users WHERE user_code = $1')) {
      const row = authUsers.get(params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    throw new Error(`unexpected query in pipeline E2E fake db: ${s}`);
  }),
  logAuditEvent: vi.fn(async () => {}),
}));
vi.mock('../services/email.js', () => ({ sendApprovalEmail: vi.fn(async () => {}), sendAnalysisReport: vi.fn(async () => {}) }));

// A tiny in-memory stand-in for Drizzle: schema.js's exported "columns" are
// just their own field name (a Proxy tags which table an object belongs to
// once, via __table), so the real `eq`/`and`/`isNull`/`desc` calls in
// analysis.js/history.js can be replaced with plain row-predicate functions
// that a hand-rolled query builder below evaluates against an in-memory array.
function fieldProxy(table) {
  return new Proxy({}, { get: (_, key) => (key === '__table' ? table : key) });
}
vi.mock('../db/schema.js', () => ({
  analyses: fieldProxy('analyses'),
  messages: fieldProxy('messages'),
  emergencyLogs: fieldProxy('emergencyLogs'),
  devices: fieldProxy('devices'),
}));
vi.mock('drizzle-orm', () => ({
  eq: (field, val) => (row) => row[field] === val,
  and: (...fns) => (row) => fns.every((fn) => fn(row)),
  isNull: (field) => (row) => row[field] == null,
  isNotNull: (field) => (row) => row[field] != null,
  inArray: (field, vals) => (row) => vals.includes(row[field]),
  desc: (field) => ({ field, dir: -1 }),
  asc: (field) => ({ field, dir: 1 }),
  sql: (strings, ...vals) => ({ strings, vals }),
}));

let tables;
let nextId;
function makeFakeDb() {
  function rowsFor(table) {
    return tables[table.__table];
  }
  return {
    insert(table) {
      return {
        values(vals) {
          const arr = Array.isArray(vals) ? vals : [vals];
          const inserted = arr.map((v) => {
            const row = { id: nextId++, createdAt: new Date(), deletedAt: null, ...v };
            rowsFor(table).push(row);
            return row;
          });
          const resultPromise = Promise.resolve(inserted);
          resultPromise.returning = () => Promise.resolve(inserted);
          return resultPromise;
        },
      };
    },
    // `selection` is only present for history.js's device-label join
    // (`select({ analysis: analyses, devicePlatform: devices.platform })`)
    // -- every other call site here still uses the plain, no-arg select()
    // and gets bare rows back, same as before.
    select(selection) {
      return {
        from(table) {
          let rows = rowsFor(table).slice();
          const builder = {
            // This fake has no `devices` table to actually join against --
            // real join *correctness* (matching a row's deviceId to a
            // registered device's platform) is covered by
            // history.rbac.test.js instead. This just needs to not crash
            // and to shape each row the way `selection` asks for, with the
            // joined column always null.
            leftJoin() {
              return builder;
            },
            where(pred) {
              rows = rows.filter(pred);
              return builder;
            },
            orderBy(spec) {
              rows = rows.slice().sort((a, b) => (a[spec.field] < b[spec.field] ? 1 : -1) * spec.dir);
              return builder;
            },
            limit(n) {
              rows = rows.slice(0, n);
              return builder;
            },
            then(resolve, reject) {
              const shaped = selection
                ? rows.map((row) => Object.fromEntries(Object.keys(selection).map((key, i) => [key, i === 0 ? row : null])))
                : rows;
              Promise.resolve(shaped).then(resolve, reject);
            },
          };
          return builder;
        },
      };
    },
  };
}
vi.mock('../db/client.js', () => ({
  isDbConfigured: () => true,
  getDb: () => makeFakeDb(),
}));

// The AI provider and quantum/fraud/portfolio engines are unit-tested on
// their own (services/*.test.js, quantum/smoke_test.py) -- stubbed here so
// this test only proves the pipeline's wiring, not Claude/Qiskit itself.
const generateAnalysisMock = vi.fn(async (systemPrompt, userPrompt) => ({
  provider: 'Claude (Anthropic)',
  content: `BOLD RAPORU\n\nKaynak belge içeriği referans alındı: ${userPrompt.includes('Pipeline E2E test belgesi') ? 'evet' : 'hayır'}`,
  usage: null,
}));
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
  wrapUntrustedEvidence: (label, content) => `--- UNTRUSTED EVIDENCE START --- (${label})\n${content}\n--- UNTRUSTED EVIDENCE END ---`,
}));
const generateReportDocxMock = vi.fn(async () => Buffer.from('fake-docx-bytes'));
const generateReportPdfMock = vi.fn(async () => Buffer.from('fake-pdf-bytes'));
vi.mock('../services/docx.js', () => ({ generateReportDocx: (...args) => generateReportDocxMock(...args) }));
vi.mock('../services/pdf.js', () => ({ generateReportPdf: (...args) => generateReportPdfMock(...args) }));
vi.mock('../services/quantum.js', () => ({
  computeQuantumProbabilities: vi.fn(async () => null),
  isIbmHardwareConfigured: () => false,
}));
vi.mock('../services/fraudDetection.js', () => ({
  computeFraudRiskScores: vi.fn(), mergeFraudResults: vi.fn(),
  verifyFraudHardwareAsync: vi.fn(), buildFraudHardwareSection: vi.fn(() => ''),
}));
vi.mock('../services/portfolioOptimizer.js', () => ({ computeOptimalAllocation: vi.fn(), mergeOptimizerResults: vi.fn() }));
vi.mock('../services/socket.js', () => ({ broadcastToUser: vi.fn(async () => {}) }));
vi.mock('../services/transactionSource.js', () => ({ parseTransactionFile: vi.fn() }));
vi.mock('../services/scenarioDataSource.js', () => ({ parseScenarioFile: vi.fn(), parseOptimizationFile: vi.fn() }));
vi.mock('../services/tableParsing.js', () => ({ sheetToText: vi.fn() }));
vi.mock('../services/weather.js', () => ({ isWeatherQuery: () => false, getLiveWeatherReply: vi.fn() }));
vi.mock('../services/webResearch.js', () => ({ researchWeb: vi.fn(async () => []), formatResearchContext: vi.fn(() => '') }));
vi.mock('../services/morningBrief.js', () => ({
  getTodayBriefing: vi.fn(), getBriefingByDate: vi.fn(), listBriefingDates: vi.fn(), generateMorningBriefIfNeeded: vi.fn(),
}));

const { default: authRouter } = await import('./auth.js');
const { default: analysisRouter } = await import('./analysis.js');
const { default: historyRouter } = await import('./history.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/analysis', analysisRouter);
  app.use('/api/history', historyRouter);
  return app;
}

const ADMIN_CODE = 'TEST-ADMIN';

beforeEach(async () => {
  process.env.DATABASE_URL = 'postgres://fake/for-pipeline-e2e-test';
  authUsers = new Map();
  authUsers.set(ADMIN_CODE, {
    user_code: ADMIN_CODE,
    password_hash: await bcrypt.hash('secret-pass', 4),
    nickname: 'BOLD',
    is_admin: true,
    email: null,
    role: 'admin',
    blocked: false,
    created_at: new Date(),
  });
  tables = { analyses: [], messages: [], emergencyLogs: [] };
  nextId = 1;
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe('Full pipeline E2E (login -> upload -> generate -> history -> export)', () => {
  it('walks the whole path through the real auth/analysis/history routes', async () => {
    const app = buildApp();

    // 1) Login -- admin accounts skip mail approval and get a JWT straight back.
    const loginRes = await request(app)
      .post('/api/auth/login-request')
      .send({ userCode: ADMIN_CODE, password: 'secret-pass' });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.status).toBe('approved');
    const authHeader = `Bearer ${loginRes.body.jwt}`;

    // 2) Upload a document -- exercises multer + the real .txt extraction path.
    const uploadRes = await request(app)
      .post('/api/analysis/upload')
      .set('Authorization', authHeader)
      .attach('file', Buffer.from('Pipeline E2E test belgesi içeriği.'), { filename: 'kaynak.txt', contentType: 'text/plain' });
    expect(uploadRes.status).toBe(200);
    expect(uploadRes.body.type).toBe('text');
    expect(uploadRes.body.text).toContain('Pipeline E2E test belgesi');

    // 3) Generate an analysis using the uploaded document as context -- persists a row.
    const genRes = await request(app)
      .post('/api/analysis/generate')
      .set('Authorization', authHeader)
      .send({ category: 'ekonomi', title: 'E2E Pipeline Raporu', prompt: 'Test analizi üret', documentContext: uploadRes.body.text, priority: 'kritik', depth: 'derin' });
    expect(genRes.status).toBe(200);
    expect(genRes.body.success).toBe(true);
    expect(genRes.body.analysisId).toBeTruthy();
    expect(genRes.body.content).toContain('evet'); // confirms documentContext reached the AI prompt
    expect(genRes.body.priority).toBe('kritik');
    expect(genRes.body.depth).toBe('derin');
    expect(tables.analyses).toHaveLength(1);
    expect(tables.analyses[0]).toMatchObject({ priority: 'kritik', depth: 'derin' });

    // A-02/A-03: the AI narrative's Evidence Object and the fused
    // no-quantum-engines-ran verdict are present even without quantum mode.
    expect(genRes.body.evidence).toEqual([
      expect.objectContaining({ claim: 'ai-narrative', engine: 'ai', source: 'Claude (Anthropic)' }),
    ]);
    expect(genRes.body.decisionFusion).toMatchObject({ engineCount: 0, agreementLevel: 'no-quantum-engines-ran' });

    // 4) History list -- the freshly generated analysis shows up for its owner.
    const listRes = await request(app).get('/api/history/list').set('Authorization', authHeader);
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].id).toBe(genRes.body.analysisId);
    expect(listRes.body[0].title).toBe('E2E Pipeline Raporu');
    expect(listRes.body[0].priority).toBe('kritik');
    expect(listRes.body[0].depth).toBe('derin');

    // 5) History detail -- same record, fetched by id.
    const detailRes = await request(app).get(`/api/history/${genRes.body.analysisId}`).set('Authorization', authHeader);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.category).toBe('ekonomi');

    // 6) Export -- DOCX and PDF downloads both succeed off the persisted row.
    const docxRes = await request(app).get(`/api/history/${genRes.body.analysisId}/download`).set('Authorization', authHeader);
    expect(docxRes.status).toBe(200);
    expect(docxRes.headers['content-type']).toContain('wordprocessingml');
    expect(generateReportDocxMock).toHaveBeenCalled();

    const pdfRes = await request(app).get(`/api/history/${genRes.body.analysisId}/download-pdf`).set('Authorization', authHeader);
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers['content-type']).toContain('application/pdf');
    expect(generateReportPdfMock).toHaveBeenCalled();
  });
});
