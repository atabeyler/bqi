/**
 * A-03 (technical audit): a lightweight synthesis pass over one run's
 * Evidence Objects (see evidence.js) -- summarizes how many engines
 * actually ran, how many were independently confirmed on real IBM Quantum
 * hardware, and whether each engine's result agreed with its own classical
 * benchmark, into one fused verdict. This does not re-run or re-score any
 * engine (there is no shared objective function across scenario/fraud/
 * optimizer to fuse numerically yet -- see the technical audit's A-03 note
 * on that as a further step); it only makes the existing per-engine
 * agreement signals visible in one place instead of requiring the reader to
 * open each engine's panel separately.
 */
export function fuseDecision(evidenceItems = []) {
  const engineItems = evidenceItems.filter((e) => e.engine !== 'ai');
  const verifiedOnHardwareCount = engineItems.filter((e) => e.verified).length;
  const disagreements = engineItems.filter((e) => typeof e.confidence === 'string' && e.confidence.includes('diverges'));

  const agreementLevel = engineItems.length === 0
    ? 'no-quantum-engines-ran'
    : disagreements.length > 0
      ? 'partial-disagreement'
      : 'consistent';

  const summary = engineItems.length === 0
    ? 'Bu rapor yalnızca YZ anlatısına dayanmaktadır — kuantum motorlarından hiçbiri çalışmadı.'
    : agreementLevel === 'consistent'
      ? `${engineItems.length} kuantum motoru çalıştı, hepsi kendi klasik karşılaştırma taban çizgisiyle uyumlu.`
      : `${engineItems.length} kuantum motorundan ${disagreements.length} tanesi klasik taban çizgisinden farklı sonuç verdi — ayrıntılar için ilgili motor panelini inceleyin.`;

  return {
    version: 1,
    engineCount: engineItems.length,
    verifiedOnHardwareCount,
    agreementLevel,
    summary,
  };
}
