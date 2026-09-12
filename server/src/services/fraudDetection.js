/** BQI Fraud/AML Detection Service — 13Q behavioral experiment. */
import path from 'path';
import { fileURLToPath } from 'url';
import { withIbmTimeout } from '../lib/quantumTimeout.js';
import { runQuantumWorker } from './quantumProcess.js';
import { enrichBehavioralFeatures } from './behavioralFeatures.js';
import { buildFraudSecondaryReviewSection, summarizeFraudConfirmation } from './fraudSecondaryFilter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, '../../quantum/fraud_detection_13q.py');
const TIMEOUT_MS = withIbmTimeout(180000);
// item 23: must match fraud_detection_13q.py's own MAX_INPUT_TRANSACTIONS --
// that script's classical pre-filter (which picks the most anomalous-looking
// records for the O(n^2) quantum kernel, instead of a blind "first N" cut)
// can only ever see what gets past this slice, so this used to make the
// prefilter dead code by cutting the input down to the kernel's own limit
// (3000) before the script ever ran.
const MAX_TRANSACTIONS = 20000;

export async function computeFraudRiskScores(transactions, opts = {}) {
  if (!Array.isArray(transactions) || transactions.length < 3) return null;
  const originalCount = transactions.length;
  const truncated = originalCount > MAX_TRANSACTIONS;
  const sliced = transactions.slice(0, MAX_TRANSACTIONS);
  const enriched = enrichBehavioralFeatures(sliced);
  const payload = { transactions: enriched, skipHardware: !!opts.skipHardware };
  const result = await runQuantumWorker({ mode: 'fraud', scriptPath: SCRIPT_PATH, payload, timeoutMs: TIMEOUT_MS, label: 'FraudDetection13Q' });
  if (result) {
    result.secondaryReview = summarizeFraudConfirmation(result.transactions);
    if (truncated) { result.truncated = true; result.originalCount = originalCount; }
  }
  return result;
}

export function buildFraudHardwareSection(hw) {
  if (!hw) return '';
  const pair = hw.pair ? `${hw.pair.a ?? '—'} ↔ ${hw.pair.b ?? '—'}` : '—';
  return `\n### Gerçek Donanım Doğrulaması\nBackend: ${hw.backend || '—'}\nShots: ${hw.shots ?? '—'}\nKarşılaştırılan çift: ${pair}\nExact fidelity: ${hw.exactFidelity ?? '—'}\nMeasured fidelity: ${hw.measuredFidelity ?? '—'}\n`;
}

export async function verifyFraudHardwareAsync(transactions) {
  const result = await computeFraudRiskScores(transactions, { skipHardware: false });
  return result ? { hardwareVerification: result.hardwareVerification || null, ibmDiagnostic: result.ibmDiagnostic || null } : null;
}

export function mergeFraudResults(fraudResult) {
  if (!fraudResult?.transactions?.length) return null;
  const flagged = fraudResult.transactions.filter(t => t.flagged);
  const rows = fraudResult.transactions.slice(0, 15).map(t =>
    `| ${t.id} | ${t.amount} | ${t.hour} | ${t.frequency} | ${t.newCounterparty ? 'Evet' : 'Hayır'} | ${t.crossBorder ? 'Evet' : 'Hayır'} | ${t.riskScore} | ${t.flagged ? '🚩 İŞARETLENDİ' : '—'} |`
  ).join('\n');
  const totalBeforePrefilter = fraudResult.prefiltered
    ? fraudResult.transactionCount + (fraudResult.excludedByPrefilter || 0)
    : fraudResult.transactionCount;
  const prefilterNote = fraudResult.prefiltered
    ? `\nKlasik ön-eleme ${totalBeforePrefilter} kayıt arasından en riskli görünen ${fraudResult.transactionCount} kaydı quantum kernel için seçti.\n`
    : '';
  return `\n## KUANTUM ANOMALİ TESPİTİ DOĞRULAMASI\n${fraudResult.transactionCount} işlem, **${fraudResult.qubits}-kübitlik** davranışsal feature-map ile değerlendirildi. K=${fraudResult.thresholdK ?? 0.79}.\n\n**${flagged.length} / ${fraudResult.transactionCount} kayıt işaretlendi.**${prefilterNote}\n| İşlem ID | Tutar | Saat | Sıklık | Yeni Taraf | Sınır Ötesi | Risk | Durum |\n|---|---:|---:|---:|---|---|---:|---|\n${rows}\n\n${fraudResult.circuitDiagram || ''}\n${buildFraudHardwareSection(fraudResult.hardwareVerification)}\n${buildFraudClassicalBenchmarkSection(fraudResult.classicalBenchmark)}${buildFraudSecondaryReviewSection(fraudResult)}`;
}

export function buildFraudClassicalBenchmarkSection(b) {
  if (!b) return '';
  return `### Klasik Anomali Tespiti Karşılaştırması\nKlasik işaretlenen: ${b.flaggedCount}. Uyum oranı: %${b.agreementPercent}.\n`;
}

export function buildFraudSecondaryReviewNote(fraudResult) {
  return buildFraudSecondaryReviewSection(fraudResult);
}
