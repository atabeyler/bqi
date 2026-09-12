/**
 * BQI Quantum Service
 * Recomputes scenario probabilities generated in quantum mode on a real
 * quantum circuit (Qiskit Aer simulator) instead of relying solely on the
 * LLM's textual estimate. Spawns the server/quantum/scenario_quantum.py process.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { withIbmTimeout } from '../lib/quantumTimeout.js';
import { runQuantumWorker } from './quantumProcess.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, '../../quantum/scenario_quantum.py');
const TIMEOUT_MS = withIbmTimeout(20000);

// Mirrors MAX_TRANSACTIONS in fraudDetection.js and MAX_SCENARIOS in
// scenario_quantum.py -- caps the payload before it reaches the Python
// worker, not just inside it, so an oversized LLM-produced scenario table
// doesn't even spend the subprocess spawn on a payload that will be truncated.
const MAX_SCENARIOS = 32;

function parsePercentToWeight(raw) {
  if (!raw) return null;
  // Turkish decimals use "," (e.g. "%42,5") — accept either separator.
  const m = String(raw).match(/(\d+(?:[.,]\d+)?)/);
  return m ? Number(m[1].replace(',', '.')) / 100 : null;
}

/**
 * @param {Array<{id:string, probability?:string}>} scenarios - output of parseScenarios()
 * @param {number} shots
 * @param {{skipHardware?: boolean}} [opts] - skipHardware=true returns the fast
 *        simulator-only result (hardwareVerification always null) so callers
 *        on the request/response path aren't blocked on the IBM queue wait;
 *        see verifyScenarioHardwareAsync for the deferred hardware run.
 * @returns {Promise<{backend:string, qubits:number, shots:number, scenarios:Array}|null>}
 *          Returns null if the Qiskit process fails (no python/qiskit, timeout, etc.)
 *          — the caller should then proceed with the LLM's original estimates.
 */
export function computeQuantumProbabilities(scenarios, shots = 4096, opts = {}) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) return Promise.resolve(null);

  const payload = {
    shots,
    skipHardware: !!opts.skipHardware,
    scenarios: scenarios.slice(0, MAX_SCENARIOS).map((s) => ({ id: s.id, weight: parsePercentToWeight(s.probability) })),
  };

  return runQuantumWorker({ mode: 'scenario', scriptPath: SCRIPT_PATH, payload, timeoutMs: TIMEOUT_MS, label: 'Quantum' });
}

/**
 * Builds the "real hardware" markdown table on its own, so a hardware
 * verification result that arrives later (see verifyScenarioHardwareAsync)
 * can be appended to an already-saved report without recomputing the rest
 * of mergeQuantumResults' output.
 */
export function buildScenarioHardwareSection(scenarios, hardwareVerification) {
  if (!hardwareVerification?.scenarios?.length) return '';
  return `\n### Gerçek Donanım Doğrulaması\n` +
    `Aynı devre ayrıca gerçek IBM Quantum donanımında (**${hardwareVerification.backend}**, ${hardwareVerification.shots} shot) bir kez daha çalıştırılmıştır ` +
    `(bu değer, yukarıdaki güven aralığına dahil edilmemiştir — donanım gürültüsü örnekleme gürültüsüyle aynı değildir):\n\n` +
    `| Senaryo | Gerçek Donanım Sonucu |\n|---|---|\n` +
    hardwareVerification.scenarios.map((s) => {
      const label = scenarios.find((m) => m.id === s.id)?.title || s.id;
      return `| ${label} | %${s.quantumProbability} |`;
    }).join('\n') + '\n';
}

/**
 * True when IBM_QUANTUM_TOKEN/IBM_QUANTUM_INSTANCE are both set, i.e. a
 * background hardware-verification run (see verifyScenarioHardwareAsync /
 * verifyFraudHardwareAsync) has a chance of producing a real result instead
 * of immediately reporting "not configured".
 */
export function isIbmHardwareConfigured() {
  return !!(process.env.IBM_QUANTUM_TOKEN && process.env.IBM_QUANTUM_INSTANCE);
}

/**
 * Re-runs the scenario circuit in the background to get the real-hardware
 * verification lane, without making the original request wait on the IBM
 * queue (see computeQuantumProbabilities' skipHardware option). The
 * simulator portion of this second run is discarded — only
 * hardwareVerification/ibmDiagnostic are used.
 */
export async function verifyScenarioHardwareAsync(scenarios, shots = 4096) {
  const result = await computeQuantumProbabilities(scenarios, shots, { skipHardware: false });
  return result ? { hardwareVerification: result.hardwareVerification || null, ibmDiagnostic: result.ibmDiagnostic || null } : null;
}

/**
 * Merges quantum results into the scenarios list and produces the
 * markdown verification section (table + confidence interval + the real
 * circuit diagram) to append to the report.
 */
/**
 * Compares the quantum-mixed distribution against the classical (no-quantum)
 * baseline every scenario already carries -- the LLM's raw estimate,
 * llmEstimate, before it went through the mixer circuit -- the same way
 * buildFraudClassicalBenchmarkSection/buildClassicalBenchmarkSection give
 * the fraud kernel and QAOA optimizer a classical comparison point instead
 * of just asserting the quantum result is meaningful.
 */
function computeScenarioClassicalBenchmark(merged) {
  const withBoth = merged.filter((s) => s.llmEstimate !== undefined && s.quantumProbability !== undefined);
  if (withBoth.length === 0) return null;

  const topByLlm = withBoth.reduce((a, b) => (b.llmEstimate > a.llmEstimate ? b : a));
  const topByQuantum = withBoth.reduce((a, b) => (b.quantumProbability > a.quantumProbability ? b : a));
  const meanAbsoluteDeviation = withBoth.reduce((sum, s) => sum + Math.abs(s.llmEstimate - s.quantumProbability), 0) / withBoth.length;

  return {
    topScenarioAgrees: topByLlm.id === topByQuantum.id,
    classicalTopId: topByLlm.id,
    quantumTopId: topByQuantum.id,
    meanAbsoluteDeviationPercent: Math.round(meanAbsoluteDeviation * 10) / 10,
  };
}

export function buildScenarioClassicalBenchmarkSection(benchmark, merged) {
  if (!benchmark) return '';
  const labelFor = (id) => merged.find((s) => s.id === id)?.title || id;
  const status = benchmark.topScenarioAgrees
    ? `✅ En olası senaryo klasik (YZ) tahminiyle örtüşüyor: **${labelFor(benchmark.classicalTopId)}**.`
    : `⚠️ Kuantum devresi en olası senaryoyu değiştirdi: YZ tahmini **${labelFor(benchmark.classicalTopId)}** iken kuantum ölçümü **${labelFor(benchmark.quantumTopId)}**'ı öne çıkardı.`;
  return `\n### Klasik Tahmin Karşılaştırması\n` +
    `Klasik (kuantum devresine hiç girmemiş) taban çizgisi, YZ'nin ham yüzde tahminidir. Ortalama mutlak sapma (YZ tahmini ↔ kuantum ölçümü): %${benchmark.meanAbsoluteDeviationPercent}.\n\n${status}\n`;
}

export function mergeQuantumResults(scenarios, quantumResult) {
  if (!quantumResult?.scenarios?.length) return { scenarios, note: null, classicalBenchmark: null };

  const merged = scenarios.map((s) => {
    const q = quantumResult.scenarios.find((x) => x.id === s.id);
    return q
      ? {
          ...s,
          llmEstimate: q.llmEstimate,
          quantumProbability: q.quantumProbability,
          quantumStdDev: q.quantumStdDev,
          quantumRangeLow: q.quantumRangeLow,
          quantumRangeHigh: q.quantumRangeHigh,
        }
      : s;
  });

  const estimateLabel = quantumResult.dataSource === 'uploaded' ? 'Yüklenen Değer' : 'YZ Tahmini';
  const rows = merged
    .filter((s) => s.quantumProbability !== undefined)
    .map((s) => `| ${s.title} | %${s.llmEstimate} | %${s.quantumProbability} | %${s.quantumRangeLow} – %${s.quantumRangeHigh} |`)
    .join('\n');

  const layerCount = quantumResult.mixerLayers?.length || 0;

  const sourceNote = quantumResult.dataSource === 'uploaded'
    ? 'Bu senaryolar kullanıcı tarafından yüklenen bir dosyadan (CSV/XLSX) çıkarılan GERÇEK senaryo verileridir.'
    : 'Gerçek veri sağlanmadığından bu senaryolar YZ tarafından üretilen tahminlerdir.';

  const hardwareSection = buildScenarioHardwareSection(merged, quantumResult.hardwareVerification);
  const classicalBenchmark = computeScenarioClassicalBenchmark(merged);
  const classicalSection = buildScenarioClassicalBenchmarkSection(classicalBenchmark, merged);

  // Only when scenario count isn't a power of two does the circuit have
  // unused "phantom" basis states to renormalize away -- see the phantom
  // basis state note in scenario_quantum.py's build_distribution().
  const phantomNote = quantumResult.phantomStateMass
    ? ` Ölçülen shot'ların %${(quantumResult.phantomStateMass * 100).toFixed(2)}'i senaryolara karşılık gelmeyen "hayalet" temel durumlara düştü ve aşağıdaki yüzdelere dahil edilmeden yeniden normalize edildi.`
    : '';

  const note = `\n## KUANTUM DEVRE DOĞRULAMASI\n` +
    `**Önemli:** Aşağıdaki yüzdeler, bu olaylara ilişkin bağımsız bir kuantum ölçümü DEĞİLDİR — YZ'nin ilk tahminleri kuantum genliği olarak ${quantumResult.qubits}-kübitlik bir devreye yüklenip, ` +
    `her kübit çiftini birbirine bağlayan ${layerCount} katmanlı belirlenmiş bir karışım (mixer) devresinden geçirildikten sonraki ölçüm dağılımıdır — devre YZ'nin ön tahminini dönüştürür, onu doğrulayan ayrı bir gerçek-dünya ölçümü üretmez. ` +
    `Tek bir ölçüm turu yerine devre ${quantumResult.batches} kez bağımsız olarak çalıştırılmış (toplam ${quantumResult.shots} ölçüm/shot); ` +
    `aşağıdaki aralık istatistiksel bir güven aralığı değil, bu ${quantumResult.batches} bağımsız turun ortalamasından ±1 standart sapma bandıdır.${phantomNote} ${sourceNote}\n` +
    `Backend: ${quantumResult.backend} (yerel kuantum devre simülatörü, devre derinliği ${quantumResult.circuitDepth} — gerçek kuantum donanımı değildir).\n\n` +
    `| Senaryo | ${estimateLabel} | Kuantum Sonucu (ortalama) | Batch Dağılım Aralığı (±1 SD) |\n|---|---|---|---|\n${rows}\n\n` +
    `### Çalıştırılan Devre\n\`\`\`\n${quantumResult.circuitDiagram}\n\`\`\`\n${classicalSection}${hardwareSection}`;

  return { scenarios: merged, note, classicalBenchmark };
}
