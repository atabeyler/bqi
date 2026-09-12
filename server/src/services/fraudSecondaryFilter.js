/**
 * Secondary fraud confirmation tier.
 *
 * The primary detector remains responsible for recall. This layer does not
 * suppress primary flags; it separates them into "confirmed" vs "review"
 * so the strongest cases can be highlighted in reports and benchmark runs.
 */

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const CONFIRMATION_RULES = [
  {
    id: 'high_frequency',
    description: 'işlem frekansı çok yüksek',
    matches: (t) => num(t.frequency) >= 8,
  },
  {
    id: 'high_risk_score',
    description: 'risk skoru çok yüksek',
    matches: (t) => num(t.riskScore) >= 81,
  },
  {
    id: 'high_classical_score',
    description: 'klasik skor çok güçlü',
    matches: (t) => num(t.classicalScore) >= 67,
  },
];

export function classifyFraudConfirmation(transaction) {
  for (const rule of CONFIRMATION_RULES) {
    if (rule.matches(transaction)) {
      return { reviewTier: 'confirmed', reviewRule: rule.id, reviewRuleLabel: rule.description };
    }
  }

  return {
    reviewTier: 'review',
    reviewRule: 'borderline',
    reviewRuleLabel: 'İkincil onay eşiğini geçmedi',
  };
}

export function annotateFraudConfirmation(transactions) {
  if (!Array.isArray(transactions)) return [];
  return transactions.map((t) => ({ ...t, ...classifyFraudConfirmation(t) }));
}

export function splitFraudConfirmation(transactions) {
  const annotated = annotateFraudConfirmation(transactions);
  const confirmed = annotated.filter((t) => t.reviewTier === 'confirmed');
  const review = annotated.filter((t) => t.reviewTier !== 'confirmed');
  return {
    annotated,
    confirmed,
    review,
    summary: {
      total: annotated.length,
      confirmedCount: confirmed.length,
      reviewCount: review.length,
    },
  };
}

export function summarizeFraudConfirmation(transactions) {
  const { confirmed, review, summary } = splitFraudConfirmation(transactions);
  return {
    total: summary.total,
    confirmedCount: summary.confirmedCount,
    reviewCount: summary.reviewCount,
    confirmedIds: confirmed.map((t) => t.id),
    reviewIds: review.map((t) => t.id),
    rules: confirmed.reduce((acc, t) => {
      acc[t.reviewRule] = (acc[t.reviewRule] || 0) + 1;
      return acc;
    }, {}),
  };
}

export function buildFraudSecondaryReviewSection(fraudResult) {
  if (!fraudResult?.transactions?.length) return '';

  const { confirmed, review, summary } = splitFraudConfirmation(fraudResult.transactions);
  const sampleRows = confirmed.slice(0, 10).map((t) =>
    `| ${t.id} | ${t.riskScore} | ${t.classicalScore} | ${t.frequency} | ${t.amount} | ${t.reviewRuleLabel} |`
  ).join('\n');

  const table = sampleRows
    ? `\n| İşlem ID | Risk | Klasik | Sıklık | Tutar | Neden |\n|---|---:|---:|---:|---:|---|\n${sampleRows}\n`
    : '\n_Onaylanan örnek bulunamadı._\n';

  return `\n### İkincil Onay Katmanı\n` +
    `Birincil modelin işaretlediği ${summary.total} kayıt, daha sıkı bir doğrulama katmanından geçirildi.\n` +
    `Güçlü onaylanan: ${summary.confirmedCount}\n` +
    `Manuel inceleme adayı: ${summary.reviewCount}\n` +
    `\nOnaylanan örnekler:\n${table}`;
}
