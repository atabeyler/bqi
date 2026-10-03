import express from 'express';
import multer from 'multer';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import { authMiddleware } from '../middleware/auth.js';
import { publicActionLimiter, analysisLimiter } from '../middleware/rateLimit.js';
import {
  generateAnalysis,
  generateAnalysisWithVision,
  streamConsultationText,
  getSystemPromptForCategory,
  getQuantumSystemPrompt,
  getScenarioDeepDivePrompt,
  getConsultationPrompt,
  getStatus,
  isFraudCategory,
  wrapUntrustedEvidence,
} from '../services/ai.js';
import { generateReportDocx } from '../services/docx.js';
import { generateReportPdf } from '../services/pdf.js';
import { sendAnalysisReport } from '../services/email.js';
import { eq, and, inArray, isNotNull, asc } from 'drizzle-orm';
import { getDb, isDbConfigured } from '../db/client.js';
import { analyses, messages } from '../db/schema.js';
import { computeQuantumProbabilities } from '../services/quantum.js';
import { parseTransactionFile } from '../services/transactionSource.js';
import { parseScenarioFile, parseOptimizationFile } from '../services/scenarioDataSource.js';
import { sheetToText } from '../services/tableParsing.js';
import { isWeatherQuery, getLiveWeatherReply } from '../services/weather.js';
import { researchWeb, formatResearchContext } from '../services/webResearch.js';
import { gatherResearchDetailed, isDemoWebResearchEnabled } from '../services/analysisResearch.js';
import { resolveResultSource } from '../services/analysisOrchestrator.js';
import { buildEvidenceItems } from '../services/evidence.js';
import { scanFile } from '../lib/fileScan.js';
import { fuseDecision } from '../services/decisionFusion.js';
import { runQuantumEngines, isHardwareVerificationPending, scheduleHardwareVerification } from '../services/analysisQuantumEngines.js';
import { broadcastToUser } from '../services/socket.js';
import { isRealTransactionArray, isRealScenarioArray, isRealOptimizationProblem } from '../services/analysisParsers.js';
import { classifyData } from '../services/decisionIntelligence.js';
import { canAccessClassification } from '../lib/rbac.js';
import { runRedTeamReview } from '../services/redTeam.js';
import { generateCoaComparison } from '../services/coaComparison.js';
import { matchesDeclaredFileType } from '../lib/fileSignature.js';
import { uploadConcurrencyGate } from '../middleware/uploadConcurrency.js';
import { logger } from '../lib/logger.js';

const router = express.Router();

function artifactLinksFor(analysisId) {
  return analysisId
    ? {
        docxUrl: `/api/history/${analysisId}/download`,
        pdfUrl: `/api/history/${analysisId}/download-pdf`,
      }
    : null;
}

function sendReportEmailInBackground({ userCode, category, title, content, aiProvider }) {
  setImmediate(() => {
    generateReportDocx({ category, title, content, userCode, aiProvider })
      .then((docxBuffer) => sendAnalysisReport(userCode, category, title, docxBuffer))
      .catch((err) => logger.error({ err }, 'Mail report generation error'));
  });
}
// S-04 (technical audit): the incoming file used to be buffered entirely in
// RAM as it streamed in (multer memoryStorage) -- uploadConcurrencyGate
// bounds how many uploads are in flight at once, but each one still spent
// its whole receive phase held in the Node heap. diskStorage instead
// streams the request body straight to a temp file, so RAM only holds one
// file at a time (read back below, once, for the parsers that need a
// Buffer) instead of N concurrent uploads' worth of in-transit bytes.
const UPLOAD_TMP_DIR = path.join(os.tmpdir(), 'bqi-uploads');
fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_TMP_DIR,
    filename: (req, file, cb) => cb(null, `${randomUUID()}-${file.originalname}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});
const require = createRequire(import.meta.url);

router.get('/status', (req, res) => {
  res.json(getStatus());
});

// Public, boolean-only diagnostic (same exposure level as /status above) --
// actually spawns the Python/Qiskit worker with a trivial payload so a
// broken deployment (e.g. qiskit failed to install, python3 missing) can
// be confirmed directly instead of only inferred from a report silently
// missing quantum results.
router.get('/quantum-status', publicActionLimiter, async (req, res) => {
  const result = await computeQuantumProbabilities([{ id: 'health-check', probability: '%50' }]);
  // Note: `result.backend` is always "qiskit-aer-simulator" -- that's the
  // simulator run that always happens. Whether IBM_QUANTUM_TOKEN/INSTANCE
  // are configured AND a real hardware run actually succeeded is only
  // reflected in hardwareVerification (null if unconfigured or the
  // hardware attempt failed/fell back -- see quantum/_ibm_backend.py).
  res.json({
    ok: !!result,
    backend: result?.backend || null,
    qubits: result?.qubits || null,
    hardwareVerification: result?.hardwareVerification || null,
    ibmDiagnostic: result?.ibmDiagnostic || null,
  });
});

// BDDK/BTK fraud-flag trend over time -- each report previously stood alone,
// with no way to see whether flagged transactions are trending up or down
// across reports. Admin-only: this aggregates flag counts across every
// user's fraud-category reports, not just the caller's own.
router.get('/fraud-trend', authMiddleware, async (req, res) => {
  if (!req.user?.isAdmin) return res.status(403).json({ error: 'Yetkisiz' });
  if (!isDbConfigured()) return res.json({ points: [] });

  try {
    const category = ['bddk', 'btk'].includes(req.query.category) ? req.query.category : null;
    const rows = await getDb()
      .select({
        category: analyses.category,
        transactionCount: analyses.fraudTransactionCount,
        flaggedCount: analyses.fraudFlaggedCount,
        createdAt: analyses.createdAt,
      })
      .from(analyses)
      .where(
        and(
          category ? eq(analyses.category, category) : inArray(analyses.category, ['bddk', 'btk']),
          isNotNull(analyses.fraudTransactionCount)
        )
      )
      .orderBy(asc(analyses.createdAt))
      .limit(1000);

    // Bucketed by day (UTC) x category so multiple reports on the same day
    // still show as one trend point instead of a noisy per-report series.
    const buckets = new Map();
    for (const r of rows) {
      const day = new Date(r.createdAt).toISOString().slice(0, 10);
      const key = `${day}|${r.category}`;
      const bucket = buckets.get(key) || { date: day, category: r.category, reportCount: 0, transactionCount: 0, flaggedCount: 0 };
      bucket.reportCount += 1;
      bucket.transactionCount += r.transactionCount || 0;
      bucket.flaggedCount += r.flaggedCount || 0;
      buckets.set(key, bucket);
    }

    const points = Array.from(buckets.values())
      .map((b) => ({ ...b, flagRate: b.transactionCount ? Math.round((b.flaggedCount / b.transactionCount) * 1000) / 10 : 0 }))
      .sort((a, b) => a.date.localeCompare(b.date));

    res.json({ points });
  } catch (err) {
    logger.error({ err }, '[Analysis] Fraud trend query error');
    res.status(500).json({ error: err.message });
  }
});

// Document upload and text extraction
router.post('/upload', authMiddleware, analysisLimiter, uploadConcurrencyGate, upload.single('file'), async (req, res) => {
  const file = req.file;
  try {
    if (!file) return res.status(400).json({ error: 'Dosya bulunamadı' });
    // diskStorage (see UPLOAD_TMP_DIR above) only wrote the file to disk --
    // read it into memory once here so the rest of this handler (magic-byte
    // check, image base64, sheetToText, pdf-parse, mammoth, etc.) can keep
    // using file.buffer exactly as it did under memoryStorage.
    file.buffer = await fs.promises.readFile(file.path);

    const name = (file.originalname || '').toLowerCase();

    // The client-supplied mimetype/extension are attacker-controlled -- an
    // executable renamed "report.txt" would otherwise sail through as plain
    // text. Check the actual bytes match what the name/mimetype claims.
    const declaredKind = file.mimetype.startsWith('image/') ? 'image'
      : name.endsWith('.xlsx') ? 'office'
      : name.endsWith('.xls') ? 'legacyOffice'
      : name.endsWith('.csv') || name.endsWith('.txt') ? 'text'
      : name.endsWith('.pdf') ? 'pdf'
      : name.endsWith('.docx') ? 'office'
      : null;
    if (declaredKind && !matchesDeclaredFileType(file.buffer, declaredKind)) {
      return res.status(400).json({ error: 'Dosya içeriği uzantısıyla/tipiyle uyuşmuyor' });
    }

    // AQ security review finding: this upload path (attachments for AI
    // analysis -- images, transaction/scenario CSVs, PDF/DOCX text
    // extraction) never went through the malware-scan pipeline at all,
    // unlike routes/files.js's general /upload -- a completely separate
    // multer instance with no scanFile() call anywhere in this file. Same
    // hook, same fail-open/fail-closed-by-classification behavior now
    // applies here too (a no-op when FILE_SCAN_WEBHOOK_URL isn't
    // configured, so an unconfigured deployment's upload flow is
    // unchanged).
    const uploadClassification = req.body?.classification;
    const scanResult = await scanFile(file.buffer, { filename: file.originalname, mimetype: file.mimetype, classification: uploadClassification });
    if (!scanResult.ok) {
      return res.status(422).json({ error: 'Dosya güvenlik taramasından geçemedi', reason: scanResult.reason });
    }

    // Image: return as base64 (for Claude Vision)
    if (file.mimetype.startsWith('image/')) {
      return res.json({
        type: 'image',
        base64: file.buffer.toString('base64'),
        mimetype: file.mimetype,
        filename: file.originalname,
      });
    }

    // Real-data upload paths: a CSV/XLSX recognized as a genuine transaction,
    // scenario, or optimization table skips the AI's invented-sample-data
    // path entirely -- see transactionSource.js / scenarioDataSource.js and
    // the realTransactions/realScenarios/realOptimization handling below.
    if (/\.(csv|xlsx|xls)$/.test(name)) {
      const txParsed = parseTransactionFile(file.buffer, file.originalname);
      if (txParsed) {
        return res.json({
          type: 'transactions',
          transactions: txParsed.transactions,
          warnings: txParsed.warnings,
          recordCount: txParsed.transactions.length,
          filename: file.originalname,
        });
      }

      const scenarioParsed = parseScenarioFile(file.buffer, file.originalname);
      if (scenarioParsed) {
        return res.json({
          type: 'scenarios',
          scenarios: scenarioParsed.scenarios,
          warnings: scenarioParsed.warnings,
          recordCount: scenarioParsed.scenarios.length,
          filename: file.originalname,
        });
      }

      const optimizationParsed = parseOptimizationFile(file.buffer, file.originalname);
      if (optimizationParsed) {
        return res.json({
          type: 'optimization',
          items: optimizationParsed.items,
          budgetPercent: optimizationParsed.budgetPercent,
          warnings: optimizationParsed.warnings,
          recordCount: optimizationParsed.items.length,
          filename: file.originalname,
        });
      }

      // Not a recognized structured table -- still usable as generic document context.
      try {
        const csvText = sheetToText(file.buffer);
        return res.json({ type: 'text', text: csvText.slice(0, 15000), length: csvText.length, filename: file.originalname });
      } catch (e) {
        return res.status(400).json({ error: 'Dosya okunamadı: ' + e.message });
      }
    }

    let text = '';

    if (name.endsWith('.txt') || file.mimetype === 'text/plain') {
      text = file.buffer.toString('utf-8');
    } else if (name.endsWith('.pdf') || file.mimetype === 'application/pdf') {
      try {
        const pdfParse = require('pdf-parse');
        const data = await pdfParse(file.buffer);
        text = data.text;
      } catch (e) {
        return res.status(500).json({ error: 'PDF okunamadı: ' + e.message });
      }
    } else if (name.endsWith('.docx') || file.mimetype.includes('wordprocessingml')) {
      try {
        const mammoth = require('mammoth');
        const result = await mammoth.extractRawText({ buffer: file.buffer });
        text = result.value;
      } catch (e) {
        return res.status(500).json({ error: 'DOCX okunamadı: ' + e.message });
      }
    } else {
      return res.status(400).json({ error: 'Desteklenmeyen format. PDF, DOCX veya TXT yükleyin.' });
    }

    const trimmed = text.trim().slice(0, 15000);
    res.json({ type: 'text', text: trimmed, length: text.length, filename: file.originalname });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (file?.path) fs.promises.unlink(file.path).catch(() => {});
  }
});

/**
 * Standard Analysis — quantum mode optional
 * Body: { category, title, prompt, quantumMode?, documentContext?, realTransactions?, realScenarios?, realOptimization? }
 * realTransactions/realScenarios/realOptimization: real records parsed from
 * an uploaded CSV/XLSX (see transactionSource.js / scenarioDataSource.js).
 * When present, the AI is told NOT to invent the corresponding table and the
 * quantum engine computes on these real rows directly instead of ones the
 * AI fabricated.
 */
const VALID_PRIORITIES = ['dusuk', 'normal', 'yuksek', 'kritik'];
const VALID_DEPTHS = ['hizli', 'standart', 'derin'];
// 'hizli' skips gatherResearchContext's web-search round-trip entirely (see
// analysisResearch.js) and asks for a shorter report. 'standart' keeps
// today's existing research + output-length behavior. 'derin' also raises
// the output budget and unlocks aiPrompts.ts's deepModeBlock (national/
// cross-entity scope expansion + cross-section consistency) -- distinct
// from 'standart' now, not just a research-skip guard.
const RESEARCH_NOTICES = {
  empty: '**NOT:** Bu rapor için canlı web araştırmasında doğrulanmış kaynak bulunamadı; rapordaki sayısal değerler ve olay ayrıntıları kaynaksız model tahminidir, karar öncesi doğrulanmalıdır.',
  error: '**NOT:** Canlı web araştırması teknik nedenle yapılamadı; rapordaki sayısal değerler ve olay ayrıntıları kaynaksız model tahminidir, karar öncesi doğrulanmalıdır.',
  skipped_classification: '**NOT:** Veri sınıfı nedeniyle canlı web araştırması yapılmadı; rapordaki sayısal değerler ve olay ayrıntıları kaynaksız model tahminidir, karar öncesi doğrulanmalıdır.',
};
const DEPTH_MAX_OUTPUT_TOKENS = { hizli: 3000, derin: 50000 };

router.post('/generate', authMiddleware, analysisLimiter, async (req, res) => {
  try {
    const {
      category, title, prompt, quantumMode = false, documentContext = null, imageData = null,
      realTransactions = null, realScenarios = null, realOptimization = null, lang = 'tr',
    } = req.body;
    const priority = VALID_PRIORITIES.includes(req.body.priority) ? req.body.priority : 'normal';
    const depth = VALID_DEPTHS.includes(req.body.depth) ? req.body.depth : 'standart';
    const userCode = req.user.userCode;

    if (!category || !prompt) {
      return res.status(400).json({ error: 'category ve prompt zorunlu' });
    }

    // Blocks generation itself (not just later read/export/download) when
    // the requester's role can't access the classification this category
    // maps to (see lib/rbac.js) -- the cheapest point to enforce this,
    // since a blocked request never reaches the AI/quantum engines or gets
    // persisted at all.
    const requestedClassification = classifyData(category, req.body.dataClassification);
    if (!canAccessClassification(req.user, requestedClassification)) {
      return res.status(403).json({ error: 'Bu veri sınıfında analiz üretme yetkiniz yok' });
    }

    const fraudCategory = isFraudCategory(category);
    const hasRealTransactions = fraudCategory && isRealTransactionArray(realTransactions);
    const hasRealScenarios = !fraudCategory && isRealScenarioArray(realScenarios);
    const hasRealOptimization = !fraudCategory && isRealOptimizationProblem(realOptimization);

    const systemPrompt = quantumMode
      ? getQuantumSystemPrompt(category, { hasRealTransactions, hasRealScenarios, hasRealOptimization }, lang, depth)
      : getSystemPromptForCategory(category, lang, depth);

    const research = await gatherResearchDetailed(category, prompt, depth, requestedClassification);
    const webContext = research.context;

    const basePrompt = `${prompt}

---
Raporun sonunda şu bilgileri mutlaka ekle:
- Kullanılan/önerilen yerli sistemler ve koordinatları (ilgili ise)
- Kurumsal koordinasyon önerileri (MSB/SSB/ilgili komutanlık)
- Bir sonraki 30 gün içinde atılması gereken kritik adımlar
- Bu konudaki ulusal mevzuat referansı (kanun/yönetmelik numarası)
${quantumMode ? '\nKUANTUM MOD AKTİF: Birden fazla senaryo hesapla, olasılık matrisi sun.' : ''}`;

    const realTransactionsNote = hasRealTransactions
      ? `[YÜKLENEN GERÇEK İŞLEM VERİSİ -- ${realTransactions.length} kayıt, kullanıcı tarafından yüklenen dosyadan çıkarıldı. BUNLARI UYDURMA/YENİDEN ÜRETME, sadece aşağıdaki gerçek kayıtlara dayanarak yorum yap:]\n` +
        realTransactions.slice(0, 20).map((t) => `${t.id}: ${t.amount} TL, saat ${t.hour}, sıklık ${t.frequency}, yeni taraf ${t.newCounterparty ? 'evet' : 'hayır'}, sınır ötesi ${t.crossBorder ? 'evet' : 'hayır'}`).join('\n') +
        (realTransactions.length > 20 ? `\n... (+${realTransactions.length - 20} kayıt daha)` : '') + '\n\n'
      : '';

    const realScenariosNote = hasRealScenarios
      ? `[YÜKLENEN GERÇEK SENARYO VERİSİ -- ${realScenarios.length} senaryo, kullanıcı tarafından yüklenen dosyadan çıkarıldı. BUNLARI UYDURMA/DEĞİŞTİRME, birincil senaryoyu bunlardan seç ve tam raporu buna göre yaz:]\n` +
        realScenarios.map((s) => `${s.title}: ${s.probability}${s.timeframe ? `, ${s.timeframe}` : ''}${s.trigger ? `, tetikleyici: ${s.trigger}` : ''}`).join('\n') + '\n\n'
      : '';

    const realOptimizationNote = hasRealOptimization
      ? `[YÜKLENEN GERÇEK OPTİMİZASYON VERİSİ -- Bütçe %${realOptimization.budgetPercent}, ${realOptimization.items.length} kalem, kullanıcı tarafından yüklenen dosyadan çıkarıldı. BU TABLOYU UYDURMA/DEĞİŞTİRME:]\n` +
        realOptimization.items.map((it) => `${it.id}: değer ${it.value}, maliyet ${it.cost}`).join('\n') + '\n\n'
      : '';

    // BQI-005 (prompt injection / untrusted evidence): documentContext (an
    // uploaded file's extracted text) and webContext (live web research
    // results) both originate outside this system's control -- wrapping
    // them in the delimited untrusted-evidence block UNTRUSTED_EVIDENCE_POLICY
    // (see aiPrompts.ts) instructs the model to honor means any embedded
    // "ignore previous instructions"-style text inside either one is
    // treated as data to report on, never as a directive this request
    // itself obeys.
    const hasRealData = hasRealTransactions || hasRealScenarios || hasRealOptimization;
    // Previously: no webContext meant no prefix at all, so the model had no
    // signal that research was skipped/empty vs. simply not mentioned --
    // it would confidently invent specific "facts" about a named incident
    // either way. Explicitly flagging the empty case is what the system
    // prompt's "GERCEK OLAY DOGRULAMA KURALI" (aiPrompts.ts) checks for.
    const webContextPrefix = webContext
      ? `${wrapUntrustedEvidence('CANLI WEB ARAŞTIRMASI', webContext)}\n`
      : '[CANLI WEB ARAŞTIRMASI SONUCU: Bu istek için hiçbir doğrulanmış arama sonucu bulunamadı (araştırma atlanmış veya sonuçsuz kalmış olabilir).]\n';
    const enrichedPrompt = documentContext || hasRealData
      ? `${webContextPrefix}${wrapUntrustedEvidence('YÜKLENEN KAYNAK BELGE', documentContext || '')}\n\n${realTransactionsNote}${realScenariosNote}${realOptimizationNote}[ANALİZ TALEBİ]\n${basePrompt}`
      : `${webContextPrefix}${basePrompt}`;

    const result = imageData?.base64
      ? await generateAnalysisWithVision(systemPrompt, enrichedPrompt, imageData.base64, imageData.mimetype, requestedClassification)
      : await generateAnalysis(systemPrompt, enrichedPrompt, { maxOutputTokens: DEPTH_MAX_OUTPUT_TOKENS[depth] }, requestedClassification);

    const {
      scenarios, quantumComputation, fraudComputation, optimizerComputation,
      finalContent, quantumWarning, hardwareScenarios, hardwareTransactions, hardwareOptimization,
    } = await runQuantumEngines({
      quantumMode, fraudCategory, resultContent: result.content,
      hasRealTransactions, realTransactions,
      hasRealScenarios, realScenarios,
      hasRealOptimization, realOptimization,
    });

    const responseTitle = title || prompt.slice(0, 80);
    // Deterministic reader-facing notice (not left to the model, which a
    // fallback provider may ignore): a report with no live sources must say
    // so, since figures in it are then model recall, not verified data.
    const researchNotice = RESEARCH_NOTICES[research.status];
    const reportContent = researchNotice ? `${researchNotice}\n\n${finalContent}` : finalContent;
    let analysisId = null;
    if (isDbConfigured()) {
      const [row] = await getDb()
        .insert(analyses)
        .values({
          userCode,
          category,
          title: responseTitle,
          content: reportContent,
          aiProvider: result.provider,
          researchStatus: research.status,
          researchSourceCount: research.sourceCount,
          priority,
          depth,
          dataClassification: requestedClassification,
          fraudTransactionCount: fraudComputation ? fraudComputation.transactionCount : null,
          fraudFlaggedCount: fraudComputation ? fraudComputation.flaggedCount : null,
          clientId: randomUUID(),
          deviceId: 'web',
        })
        .returning({ id: analyses.id });
      analysisId = row.id;
    }

    const includeArtifacts = req.body.includeArtifacts === true;
    let artifactPayload = {};
    if (includeArtifacts) {
      const [docxBuffer, pdfBuffer] = await Promise.all([
        generateReportDocx({
          category,
          title: responseTitle,
          content: reportContent,
          userCode,
          aiProvider: result.provider
        }),
        generateReportPdf({
          category,
          title: responseTitle,
          content: reportContent,
          userCode,
          aiProvider: result.provider
        }),
      ]);
      artifactPayload = {
        docxBase64: docxBuffer.toString('base64'),
        pdfBase64: pdfBuffer.toString('base64'),
      };
    }

    // In-app/device notification for the requesting user, sent independently
    // of the res.json() below -- generation can run long enough that a
    // client-side timeout (browser/proxy) drops the original request before
    // the response arrives, in which case this socket event is the only
    // signal (besides the email above) that the report actually finished.
    broadcastToUser(req.app.get('io'), userCode, 'analysis:completed', { analysisId, category, title: responseTitle })
      .catch(() => {});

    const hardwarePending = isHardwareVerificationPending({ hardwareScenarios, hardwareTransactions, hardwareOptimization });

    // A-02/A-03 (technical audit): normalize every claim this run produced
    // into Evidence Objects, then fuse them into one agreement verdict --
    // see evidence.js/decisionFusion.js. Computed from the same
    // quantum/fraud/optimizer computations already gathered above, so this
    // adds no extra engine calls.
    const evidence = buildEvidenceItems({
      provider: result.provider,
      quantum: quantumComputation,
      fraud: fraudComputation,
      optimizer: optimizerComputation,
    });
    const decisionFusion = fuseDecision(evidence);

    // BQI-016: opt-in red-team/critique pass -- only runs when the request
    // explicitly asks for it (never on by default, so this never changes
    // existing traffic's latency/cost/behavior). Best-effort: a failure
    // here (including a data-egress policy denial for RESTRICTED/
    // CONFIDENTIAL data) never fails the primary analysis, which has
    // already succeeded and been generated by this point.
    let redTeamReview = null;
    if (req.body.redTeamReview === true) {
      try {
        const review = await runRedTeamReview(finalContent, { category, classification: requestedClassification });
        redTeamReview = { critique: review.critique, provider: review.provider };
      } catch (err) {
        logger.warn({ err }, '[RedTeam] review unavailable for this analysis');
        redTeamReview = { error: err.code === 'DATA_EGRESS_POLICY_DENIED' ? 'POLICY_DENIED' : 'UNAVAILABLE' };
      }
    }

    res.json({
      success: true,
      analysisId,
      provider: result.provider,
      // Read (and stripped before the client ever sees it) by
      // analysisTraceMiddleware for the decision_records audit trail --
      // see that middleware's own comment for why the masked `provider`
      // field above isn't enough for saveDecisionRecord()'s ai_provider/
      // model_name columns.
      _realProvider: result.realProvider,
      title: responseTitle,
      content: reportContent,
      research: { status: research.status, sourceCount: research.sourceCount },
      priority,
      depth,
      evidence,
      decisionFusion,
      redTeamReview,
      artifacts: artifactLinksFor(analysisId),
      ...artifactPayload,
      quantumMode,
      quantumWarning,
      scenarios,
      quantum: quantumComputation
        ? {
            backend: quantumComputation.backend,
            qubits: quantumComputation.qubits,
            shots: quantumComputation.shots,
            batches: quantumComputation.batches,
            circuitDepth: quantumComputation.circuitDepth,
            phantomStateMass: quantumComputation.phantomStateMass ?? null,
            environmentFingerprint: quantumComputation.environmentFingerprint || null,
            reproducibility: quantumComputation.reproducibility || null,
            classicalBenchmark: quantumComputation.classicalBenchmark || null,
            dataSource: quantumComputation.dataSource,
            resultSource: resolveResultSource(quantumComputation),
            hardwareVerification: quantumComputation.hardwareVerification || null,
            ibmDiagnostic: quantumComputation.ibmDiagnostic || null,
            hardwarePending: hardwarePending && !!hardwareScenarios,
          }
        : null,
      fraud: fraudComputation
        ? {
            backend: fraudComputation.backend,
            qubits: fraudComputation.qubits,
            circuitDepth: fraudComputation.circuitDepth,
            transactionCount: fraudComputation.transactionCount,
            flaggedCount: fraudComputation.flaggedCount,
            transactions: fraudComputation.transactions,
            dataSource: fraudComputation.dataSource,
            resultSource: resolveResultSource(fraudComputation),
            hardwareVerification: fraudComputation.hardwareVerification || null,
            ibmDiagnostic: fraudComputation.ibmDiagnostic || null,
            environmentFingerprint: fraudComputation.environmentFingerprint || null,
            reproducibility: fraudComputation.reproducibility || null,
            classicalBenchmark: fraudComputation.classicalBenchmark || null,
            prefiltered: !!fraudComputation.prefiltered,
            excludedByPrefilter: fraudComputation.excludedByPrefilter || 0,
            secondaryReview: fraudComputation.secondaryReview || null,
            hardwarePending: hardwarePending && !!hardwareTransactions,
          }
        : null,
      optimizer: optimizerComputation
        ? {
            backend: optimizerComputation.backend,
            qubits: optimizerComputation.qubits,
            circuitDepth: optimizerComputation.circuitDepth,
            selected: optimizerComputation.selected,
            totalValue: optimizerComputation.totalValue,
            totalCost: optimizerComputation.totalCost,
            budgetPercent: optimizerComputation.budgetPercent,
            items: optimizerComputation.items,
            dataSource: optimizerComputation.dataSource,
            resultSource: resolveResultSource(optimizerComputation),
            environmentFingerprint: optimizerComputation.environmentFingerprint || null,
            reproducibility: optimizerComputation.reproducibility || null,
            classicalBenchmark: optimizerComputation.classicalBenchmark || null,
            seed: optimizerComputation.seed ?? null,
            qaoaLayers: optimizerComputation.qaoaLayers ?? null,
            hybrid: !!optimizerComputation.hybrid,
            partitionCount: optimizerComputation.partitionCount ?? 1,
            hardwareVerification: optimizerComputation.hardwareVerification || null,
            ibmDiagnostic: optimizerComputation.ibmDiagnostic || null,
            hardwarePending: hardwarePending && !!hardwareOptimization,
          }
        : null
    });

    if (req.body.emailReport === true) {
      sendReportEmailInBackground({
        userCode,
        category,
        title: responseTitle,
        content: reportContent,
        aiProvider: result.provider,
      });
    }

    if (hardwarePending) {
      scheduleHardwareVerification({
        io: req.app.get('io'), analysisId, userCode, hardwareScenarios, hardwareTransactions, hardwareOptimization, finalContent: reportContent,
      });
    }
  } catch (err) {
    logger.error({ err }, 'Analysis error');
    res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
});

/**
 * Alternative scenario deep-dive analysis
 */
router.post('/scenario-deep-dive', authMiddleware, analysisLimiter, async (req, res) => {
  try {
    const { category, scenarioId, scenarioSummary, lang = 'tr' } = req.body;
    const userCode = req.user.userCode;

    const deepDiveClassification = classifyData(category, req.body.dataClassification);
    if (!canAccessClassification(req.user, deepDiveClassification)) {
      return res.status(403).json({ error: 'Bu veri sınıfında analiz üretme yetkiniz yok' });
    }

    const systemPrompt = getScenarioDeepDivePrompt(category, scenarioId, scenarioSummary, lang);
    const userPrompt = `"${scenarioId}" senaryosunun tam derinlemesine analizini hazırla.\nSenaryo özeti: ${scenarioSummary}\nSanki bu birincil senaryoymuş gibi eksiksiz bir BOLD raporu yaz.`;

    const result = await generateAnalysis(systemPrompt, userPrompt, {}, deepDiveClassification);

    let analysisId = null;
    if (isDbConfigured()) {
      const [row] = await getDb()
        .insert(analyses)
        .values({
          userCode,
          category,
          title: `[ALT-SENARYO] ${scenarioId}`,
          content: result.content,
          aiProvider: result.provider,
          dataClassification: deepDiveClassification,
          clientId: randomUUID(),
          deviceId: 'web',
        })
        .returning({ id: analyses.id });
      analysisId = row.id;
    }

    const responseTitle = `ALTERNATİF SENARYO: ${scenarioId}`;
    const includeArtifacts = req.body.includeArtifacts === true;
    let artifactPayload = {};
    if (includeArtifacts) {
      const [docxBuffer, pdfBuffer] = await Promise.all([
        generateReportDocx({
          category,
          title: responseTitle,
          content: result.content,
          userCode,
          aiProvider: result.provider
        }),
        generateReportPdf({
          category,
          title: responseTitle,
          content: result.content,
          userCode,
          aiProvider: result.provider
        }),
      ]);
      artifactPayload = {
        docxBase64: docxBuffer.toString('base64'),
        pdfBase64: pdfBuffer.toString('base64'),
      };
    }

    res.json({
      success: true,
      analysisId,
      provider: result.provider,
      title: responseTitle,
      content: result.content,
      artifacts: artifactLinksFor(analysisId),
      ...artifactPayload,
      scenarioId
    });
  } catch (err) {
    logger.error({ err }, 'Scenario analysis error');
    res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
});

/**
 * BQI-017: Option / course-of-action comparison. General strategic/
 * operational decision support -- not a weapons-targeting or autonomous-
 * strike system. Body: { topic, category?, options: [{id, title, description?}], dataClassification? }
 */
router.post('/coa-compare', authMiddleware, analysisLimiter, async (req, res) => {
  try {
    const { topic, category = null, options } = req.body;
    if (!topic || !Array.isArray(options) || options.length < 2) {
      return res.status(400).json({ error: 'topic ve en az 2 seçenek (options) zorunlu' });
    }
    const classification = classifyData(category, req.body.dataClassification);
    if (!canAccessClassification(req.user, classification)) {
      return res.status(403).json({ error: 'Bu veri sınıfında karşılaştırma üretme yetkiniz yok' });
    }

    const result = await generateCoaComparison(topic, options, classification);
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error({ err }, 'COA comparison error');
    res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
});

/**
 * Consultation chat — documentContext optional
 */
router.post('/chat', authMiddleware, analysisLimiter, async (req, res) => {
  try {
    const { message, history = [], documentContext = null, imageData = null } = req.body;
    const userCode = req.user.userCode;
    // Chat has no category, so it can't be classified from one like
    // /generate above -- defaults to INTERNAL (same default classifyData()
    // itself uses for an uncategorized request) unless the caller passes an
    // explicit override.
    const chatClassification = classifyData(null, req.body.dataClassification);

    if (isWeatherQuery(message)) {
      const weatherText = await getLiveWeatherReply(message);
      if (isDbConfigured()) {
        await getDb().insert(messages).values([
          { fromUser: userCode, toUser: 'BQI', message, messageType: 'consultation' },
          { fromUser: 'BQI', toUser: userCode, message: weatherText, messageType: 'consultation' },
        ]);
      }
      return res.json({ provider: 'Live Weather (Open-Meteo)', content: weatherText });
    }

    const systemPrompt = getConsultationPrompt();

    const historyStr = history.length
      ? history.map(m => `${m.role === 'user' ? 'Kullanıcı' : 'Asistan'}: ${m.content}`).join('\n') + '\n'
      : '';

    // BQI-005 (prompt injection / untrusted evidence): same wrapping as
    // /generate above -- documentContext and webContext are externally
    // sourced (an uploaded file, live web research) and must be delimited
    // as inert data, never concatenated raw into the prompt the model sees.
    const docPrefix = documentContext
      ? `${wrapUntrustedEvidence('YÜKLENEN KAYNAK BELGE', documentContext)}\n\n`
      : '';

    // Same CONFIDENTIAL/RESTRICTED gate (and BQI_DEMO_WEB_RESEARCH escape
    // hatch) as /generate's gatherResearchContext() -- this call site
    // predates that fix and was missed then, so it's duplicated here
    // rather than routed through gatherResearchContext itself (that
    // function's category-sourced dual-query shape doesn't fit a
    // freeform chat message the same way).
    const WEB_RESEARCH_BLOCKED_CLASSIFICATIONS = new Set(['CONFIDENTIAL', 'RESTRICTED']);
    let webContext = '';
    if (isDemoWebResearchEnabled() || !WEB_RESEARCH_BLOCKED_CLASSIFICATIONS.has(chatClassification)) {
      try {
        const webResults = await researchWeb(message);
        webContext = formatResearchContext(webResults);
      } catch (e) {
        logger.warn({ err: e }, '[WebResearch] search error');
      }
    }
    const webContextWrapped = webContext ? wrapUntrustedEvidence('CANLI WEB ARAŞTIRMASI', webContext) : '';

    const userPrompt = `${webContextWrapped ? `${webContextWrapped}\n` : ''}${docPrefix}${historyStr}Kullanıcı: ${message}\n\nNot: Eğer web araştırması geldiyse önce onu baz al, kaynaklarla tutarlı cevap ver.`;

    // If an image is present, use the existing one-shot (non-streaming) vision path;
    // for text-only chat the reply streams in real time.
    const result = imageData?.base64
      ? await generateAnalysisWithVision(systemPrompt, userPrompt, imageData.base64, imageData.mimetype, chatClassification)
      : await streamConsultationText(systemPrompt, userPrompt, res, chatClassification);

    if (isDbConfigured()) {
      await getDb().insert(messages).values([
        { fromUser: userCode, toUser: 'BQI', message, messageType: 'consultation' },
        { fromUser: 'BQI', toUser: userCode, message: result.content, messageType: 'consultation' },
      ]);
    }

    if (!res.headersSent) {
      res.json({ provider: result.provider, content: result.content });
    }
  } catch (err) {
    logger.error({ err }, 'Chat error');
    if (!res.headersSent) {
      res.status(err.status || 500).json({ error: err.message, code: err.code });
    } else {
      res.end();
    }
  }
});

export default router;
