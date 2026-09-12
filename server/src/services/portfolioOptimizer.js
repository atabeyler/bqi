/**
 * BQI Quantum Resource-Allocation Optimizer Service
 * Solves a real budget-constrained selection problem (which candidate
 * projects/items to fund within a budget) with QAOA instead of relying on
 * the LLM's own judgment. Spawns server/quantum/portfolio_optimizer.py.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { withIbmTimeout } from '../lib/quantumTimeout.js';
import { runQuantumWorker } from './quantumProcess.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, '../../quantum/portfolio_optimizer.py');
// 45s covers one QAOA circuit's classical optimization loop (dozens of
// circuit evaluations); withIbmTimeout() adds the IBM hardware wait budget
// on top when configured.
const SINGLE_CIRCUIT_TIMEOUT_MS = 45000;
// Mirrors MAX_ITEMS/MAX_TOTAL_ITEMS in portfolio_optimizer.py -- above
// MAX_ITEMS the script runs the hybrid decomposition (one QAOA circuit per
// partition, sequentially), so the timeout budget scales with how many
// partitions that could take.
const MAX_ITEMS_PER_PARTITION = 8;
const MAX_TOTAL_ITEMS = 24;

/**
 * @param {Array<{id:string, value:number, cost:number}>} items
 * @param {number} budgetPercent
 * @param {{skipHardware?: boolean}} [opts] - skipHardware=true (used on the
 *        fast /generate request path) returns the simulator-only result
 *        without querying real IBM hardware at all, so the request isn't
 *        blocked on the IBM queue wait -- see verifyOptimizerHardwareAsync
 *        for the deferred hardware-verification lane. The simulator result
 *        is always the authoritative decision either way (see optimize()'s
 *        docstring in portfolio_optimizer.py): hardware, when queried, is
 *        only ever an independent verification data point.
 * @returns {Promise<{backend:string, qubits:number, circuitDepth:number, circuitDiagram:string,
 *          selected:string[], totalValue:number, totalCost:number, items:Array}|null>}
 *          Returns null if the Python process fails — the caller should then
 *          proceed with the LLM's narrative recommendation unscored.
 */
export function computeOptimalAllocation(items, budgetPercent, opts = {}) {
  if (!Array.isArray(items) || items.length < 2) return Promise.resolve(null);

  const partitionCount = Math.max(1, Math.ceil(Math.min(items.length, MAX_TOTAL_ITEMS) / MAX_ITEMS_PER_PARTITION));
  // skipHardware requests never wait on the IBM queue, so they only need the
  // classical/simulator budget, not withIbmTimeout's added hardware-wait margin.
  const timeoutMs = opts.skipHardware
    ? SINGLE_CIRCUIT_TIMEOUT_MS * partitionCount
    : withIbmTimeout(SINGLE_CIRCUIT_TIMEOUT_MS * partitionCount);

  return runQuantumWorker({
    mode: 'portfolio',
    scriptPath: SCRIPT_PATH,
    payload: { items, budgetPercent, skipHardware: !!opts.skipHardware },
    timeoutMs,
    label: 'PortfolioOptimizer',
  });
}

/**
 * Re-runs the optimizer in the background to get the real-hardware
 * verification lane, without making the original request wait on the IBM
 * queue (see computeOptimalAllocation's skipHardware option). Mirrors
 * verifyScenarioHardwareAsync/verifyFraudHardwareAsync in quantum.js /
 * fraudDetection.js. Only hardwareVerification/ibmDiagnostic from this
 * second run are used — the simulator decision from the original
 * (skipHardware) run remains the one already shown to the user.
 */
export async function verifyOptimizerHardwareAsync(items, budgetPercent) {
  const result = await computeOptimalAllocation(items, budgetPercent, { skipHardware: false });
  return result ? { hardwareVerification: result.hardwareVerification || null, ibmDiagnostic: result.ibmDiagnostic || null } : null;
}

/**
 * Builds the "real hardware" markdown section on its own, so a hardware
 * verification result that arrives later (see verifyOptimizerHardwareAsync)
 * can be appended to an already-saved report. Never restates or changes the
 * selection/totals already shown — hardware is a verification data point,
 * not an alternate decision.
 */
export function buildOptimizerHardwareSection(hardwareVerification) {
  if (!hardwareVerification?.best) return '';
  const { backend, shots, best, matchesSimulator } = hardwareVerification;
  const status = matchesSimulator
    ? '✅ Gerçek donanım ölçümü, simülatör tarafından belirlenen seçimle aynı sonuca ulaştı.'
    : '⚠️ Gerçek donanım ölçümü farklı bir bitstring öne çıkardı (donanım gürültüsü nedeniyle beklenen bir sapma) — raporlanan seçim yine de simülatör sonucudur, bu satır yalnızca doğrulama amaçlıdır.';
  return `\n### Gerçek Donanım Doğrulaması\n` +
    `Aynı devre ayrıca gerçek IBM Quantum donanımında (**${backend}**, ${shots} shot) bir kez daha çalıştırılmıştır ` +
    `(bu değer raporlanan seçimi değiştirmez — yalnızca bağımsız bir doğrulama ölçümüdür):\n\n` +
    `Donanım ölçümüne göre toplam değer: ${best.totalValue} · toplam maliyet: %${best.totalCost}\n\n${status}\n`;
}

/**
 * Produces the markdown verification section (selected/rejected item table +
 * the real QAOA circuit diagram) to append to the report.
 */
export function mergeOptimizerResults(optimizerResult) {
  if (!optimizerResult?.items?.length) return null;

  const rows = optimizerResult.items
    .map((it) => `| ${it.id} | ${it.value} | ${it.cost} | ${it.selected ? '✅ Seçildi' : '—'} |`)
    .join('\n');

  const hardwareNote = optimizerResult.backend !== 'qiskit-aer-simulator'
    ? ` Son ölçüm gerçek kuantum donanımında (**${optimizerResult.backend}**) yapılmıştır.`
    : optimizerResult.ibmHardwareAttempted
      ? ' Gerçek donanıma gönderim denendi ancak kuyruk/zaman aşımı nedeniyle yerel simülatöre düşüldü.'
      : '';

  const sourceNote = optimizerResult.dataSource === 'uploaded'
    ? ' Kalem/değer/maliyet tablosu kullanıcı tarafından yüklenen bir dosyadan (CSV/XLSX) çıkarılan GERÇEK verilerdir.'
    : ' Gerçek veri sağlanmadığından bu tablo YZ tarafından üretilmiştir.';

  const hybridNote = optimizerResult.hybrid
    ? ` **Hibrit çözüm:** ${optimizerResult.items.length} kalem, tek bir QAOA devresinin taşıyabileceği kalem sayısının (8) üzerinde olduğu için değer/maliyet oranına göre sıralanıp ${optimizerResult.partitionCount} gruba (her biri kendi QAOA devresiyle) bölünerek çözülmüştür. Bu, gruplar arası olası ödünleşimleri gözden kaçırabilecek bir yaklaşık çözümdür — aşağıdaki klasik karşılaştırma bu farkı gösterir.`
    : '';

  // item 24: QAOA is a heuristic (COBYLA-tuned variational circuit) --
  // classical_optimal() in portfolio_optimizer.py computes the true exact
  // optimum via dynamic programming on the same problem, so we always know
  // whether QAOA actually found the best answer or just a plausible one.
  // This used to present the QAOA selection as THE answer unconditionally,
  // with the classical comparison relegated to a secondary section --
  // exactly backwards when QAOA demonstrably did worse. Below, a beaten
  // QAOA result is relabeled as an experimental/comparison data point and
  // the classical optimum (verifiably correct, no heuristic involved) is
  // surfaced as the recommended selection instead -- same "verification
  // lane, never the authoritative decision" pattern already used for real
  // IBM hardware runs (see buildOptimizerHardwareSection above).
  const benchmark = optimizerResult.classicalBenchmark;
  const qaoaBeaten = benchmark && !benchmark.matchesOptimal;

  const heading = qaoaBeaten
    ? '## KUANTUM KAYNAK TAHSİSİ OPTİMİZASYONU (QAOA — DENEYSEL KARŞILAŞTIRMA)'
    : '## KUANTUM KAYNAK TAHSİSİ OPTİMİZASYONU (QAOA)';

  const beatenNote = qaoaBeaten
    ? `\n\n⚠️ **DENEYSEL SONUÇ:** Bu QAOA çözümü klasik optimumdan %${benchmark.optimalityGapPercent} daha düşük değerlidir (bkz. aşağıdaki karşılaştırma). Bu, QAOA'nın kendisi doğrulanmış bir kuantum avantajı DEĞİL, deneysel bir yaklaşık-çözüm denemesi olduğu için beklenen bir durumdur. **Karar için aşağıdaki "Klasik Optimum" satırı esas alınmalıdır, bu bölümdeki QAOA seçimi değil.**`
    : '';

  const recommendedRows = qaoaBeaten
    ? optimizerResult.items
        .map((it) => {
          const isClassicallySelected = benchmark.selected.includes(it.id);
          return `| ${it.id} | ${it.value} | ${it.cost} | ${isClassicallySelected ? '✅ Seçildi (klasik optimum)' : '—'} |`;
        })
        .join('\n')
    : rows;

  const note = `\n${heading}\n` +
    `Aşağıdaki seçim, ${optimizerResult.qubits}-kübitlik bir QAOA (Quantum Approximate Optimization Algorithm) devresiyle ` +
    `gerçek bir kısıtlı optimizasyon problemi olarak çözülmüştür — bütçe kısıtı (%${optimizerResult.budgetPercent}) kayan (slack) kübitlerle ` +
    `devreye tam olarak kodlanmış, klasik bir COBYLA optimizasyon döngüsü devrenin parametrelerini ayarlamıştır. ` +
    `Sonuç, bütçeyi aşmayan (fizibıl) ölçümler arasından en yüksek değerli olanıdır.${hardwareNote}${sourceNote}${hybridNote}${beatenNote}\n\n` +
    (qaoaBeaten
      ? `**Önerilen seçim (klasik optimum): Toplam değer ${benchmark.totalValue} · Toplam maliyet %${benchmark.totalCost} / %${optimizerResult.budgetPercent} bütçe**\n` +
        `*(QAOA'nın kendi bulduğu deneysel sonucu: Toplam değer ${optimizerResult.totalValue} · Toplam maliyet %${optimizerResult.totalCost})*\n\n`
      : `**Toplam değer: ${optimizerResult.totalValue} · Toplam maliyet: %${optimizerResult.totalCost} / %${optimizerResult.budgetPercent} bütçe**\n\n`) +
    `| Kalem | Değer | Maliyet | Durum |\n|---|---|---|---|\n${recommendedRows}\n\n` +
    `### QAOA Devresi\n\`\`\`\n${optimizerResult.circuitDiagram}\n\`\`\`\n` +
    buildClassicalBenchmarkSection(optimizerResult);

  return note;
}

/**
 * Compares the QAOA result against a classical exact optimum computed on
 * the same problem via dynamic programming (see classical_optimal() in
 * portfolio_optimizer.py), so the report doesn't just assert QAOA found a
 * good answer — it shows the true optimum and the exact gap. Doubles as
 * the ground truth the hybrid decomposition path (optimizerResult.hybrid)
 * is scored against too, since it runs on the full item set either way.
 */
export function buildClassicalBenchmarkSection(optimizerResult) {
  const benchmark = optimizerResult?.classicalBenchmark;
  if (!benchmark) return '';
  const status = benchmark.matchesOptimal
    ? '✅ Sonuç klasik optimuma eşit (optimality gap: %0).'
    : `⚠️ QAOA sonucu klasik optimumdan %${benchmark.optimalityGapPercent} daha düşük değerli — karar için klasik optimum satırı esas alınmalıdır, QAOA burada yalnızca deneysel bir karşılaştırma noktasıdır.`;
  const methodLabel = optimizerResult.hybrid ? 'QAOA (hibrit)' : 'QAOA (kuantum)';
  return `\n### Klasik Optimum Karşılaştırması (Dinamik Programlama Benchmark)\n` +
    `Aynı problem, klasik (kuantum içermeyen) bir dinamik programlama (0/1 sırt çantası) algoritmasıyla da tam olarak çözülmüş ve sonuçla karşılaştırılmıştır:\n\n` +
    `| Yöntem | Toplam Değer | Toplam Maliyet |\n|---|---|---|\n` +
    `| ${methodLabel} | ${optimizerResult.totalValue} | ${optimizerResult.totalCost} |\n` +
    `| Klasik optimum (dinamik programlama) | ${benchmark.totalValue} | ${benchmark.totalCost} |\n\n` +
    `${status}\n`;
}
