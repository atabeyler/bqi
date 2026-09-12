import { z } from 'zod';

export const BCI_ASSESSMENT_VERDICTS = ['NO_FINDINGS', 'NEEDS_REVIEW', 'CRITICAL', 'PARTIAL_COVERAGE'] as const;
export type BciAssessmentVerdict = (typeof BCI_ASSESSMENT_VERDICTS)[number];

export const advisorNarrativeSchema = z.object({
  summary: z.string().min(1),
  coverageNarrative: z.string().min(1),
  limitations: z.array(z.string().min(1)).min(1).max(8),
  suggestedNextStep: z.string().min(1),
});

export type AdvisorNarrative = z.infer<typeof advisorNarrativeSchema>;

export type AdvisorFinding = {
  id: string;
  title?: string;
  risk_score?: number | null;
  priority?: string | null;
};

export type AdvisorAssessment = {
  verdict: BciAssessmentVerdict;
  summary: string;
  scopeCovered: string[];
  coverageNarrative: string;
  keyEvidence: Array<{
    findingId: string;
    title: string;
    riskScore: number | null;
    priority: string | null;
  }>;
  limitations: string[];
  suggestedNextStep: string;
};

export type AdvisorResult<Entry> = AdvisorAssessment & {
  adaptivePlan: Entry[];
  source: 'ai' | 'deterministic';
  error?: string;
};

const LANGUAGE_NAMES: Record<string, string> = {
  tr: 'Turkish',
  en: 'English',
  de: 'German',
  fr: 'French',
  ar: 'Arabic',
};

export function normalizeAdvisorLanguage(language: string) {
  return Object.hasOwn(LANGUAGE_NAMES, language) ? language : 'tr';
}

export function advisorLanguageName(language: string) {
  return LANGUAGE_NAMES[normalizeAdvisorLanguage(language)];
}

export function deriveAdvisorVerdict(findings: AdvisorFinding[], anyEngineFailed: boolean): BciAssessmentVerdict {
  if (findings.some((finding) => finding.priority === 'IMMEDIATE')) return 'CRITICAL';
  if (anyEngineFailed) return 'PARTIAL_COVERAGE';
  if (findings.length > 0) return 'NEEDS_REVIEW';
  return 'NO_FINDINGS';
}

export function assembleAdvisorAssessment({
  findings,
  anyEngineFailed,
  scopeCovered,
  narrative,
  factualLimitations = [],
}: {
  findings: AdvisorFinding[];
  anyEngineFailed: boolean;
  scopeCovered: string[];
  narrative: AdvisorNarrative;
  factualLimitations?: string[];
}): AdvisorAssessment {
  return {
    // Security conclusions and evidence identity are derived exclusively
    // from immutable BCI facts. The model only supplies explanatory prose.
    verdict: deriveAdvisorVerdict(findings, anyEngineFailed),
    summary: narrative.summary,
    scopeCovered,
    coverageNarrative: narrative.coverageNarrative,
    keyEvidence: findings.slice(0, 5).map((finding) => ({
      findingId: finding.id,
      title: finding.title || finding.id,
      riskScore: finding.risk_score ?? null,
      priority: finding.priority ?? null,
    })),
    limitations: [...new Set([...factualLimitations, ...narrative.limitations])],
    suggestedNextStep: narrative.suggestedNextStep,
  };
}

type FallbackReason = 'NOT_RUN' | 'NO_EVIDENCE' | 'AI_UNAVAILABLE';

const FALLBACK_COPY: Record<string, Record<FallbackReason, (subject: string) => AdvisorNarrative>> = {
  tr: {
    NOT_RUN: (subject) => ({ summary: `${subject} bu taramada çalışmadı; uyarlanabilir tur için gerçek dayanak yok.`, coverageNarrative: 'Henüz doğrulanmış bir temel tur kapsamı yok.', limitations: ['Temel tur tamamlanmadığı için uyarlanabilir öneri üretilemedi.'], suggestedNextStep: 'Önce temel turu çalıştırın ve gerçek sonuçları yeniden değerlendirin.' }),
    NO_EVIDENCE: (subject) => ({ summary: `${subject} için uyarlanabilir turu gerekçelendirecek gerçek bulgu veya gözlem yok.`, coverageNarrative: 'Yalnız tamamlanan temel tarama kapsamı değerlendirildi.', limitations: ['Ek tur önermek için yeterli gerçek kanıt yok.'], suggestedNextStep: 'Temel sonuçları kullanın; yeni kanıt oluşursa uyarlanabilir değerlendirmeyi tekrarlayın.' }),
    AI_UNAVAILABLE: (subject) => ({ summary: `AI danışmanı kullanılamadı; ${subject} temel stratejisi değişmeden korunuyor.`, coverageNarrative: 'Yalnız gerçek temel tarama kapsamı kullanıldı.', limitations: ['AI yorumu üretilemedi; uyarlanabilir ek tur önerilmedi.'], suggestedNextStep: 'Temel sonuçları inceleyin ve ek tur gerekip gerekmediğine kullanıcı olarak karar verin.' }),
  },
  en: {
    NOT_RUN: (subject) => ({ summary: `${subject} did not run in this scan; there is no real basis for an adaptive round.`, coverageNarrative: 'No verified base-round coverage is available yet.', limitations: ['An adaptive recommendation cannot be produced before the base round completes.'], suggestedNextStep: 'Run the base round first and reassess its real results.' }),
    NO_EVIDENCE: (subject) => ({ summary: `There are no real findings or observations that justify an adaptive ${subject} round.`, coverageNarrative: 'Only completed base-scan coverage was assessed.', limitations: ['There is insufficient real evidence to recommend an additional round.'], suggestedNextStep: 'Use the base results and reassess if new evidence becomes available.' }),
    AI_UNAVAILABLE: (subject) => ({ summary: `The AI advisor was unavailable; the ${subject} base strategy remains unchanged.`, coverageNarrative: 'Only real base-scan coverage was used.', limitations: ['AI interpretation was unavailable; no adaptive round was proposed.'], suggestedNextStep: 'Review the base results and decide whether an additional round is appropriate.' }),
  },
  de: {
    NOT_RUN: (subject) => ({ summary: `${subject} wurde in diesem Scan nicht ausgeführt; es gibt keine reale Grundlage für eine adaptive Runde.`, coverageNarrative: 'Es liegt noch keine verifizierte Abdeckung der Basisrunde vor.', limitations: ['Vor Abschluss der Basisrunde kann keine adaptive Empfehlung erstellt werden.'], suggestedNextStep: 'Führen Sie zuerst die Basisrunde aus und bewerten Sie deren reale Ergebnisse erneut.' }),
    NO_EVIDENCE: (subject) => ({ summary: `Es gibt keine realen Befunde oder Beobachtungen, die eine adaptive ${subject}-Runde rechtfertigen.`, coverageNarrative: 'Bewertet wurde nur die abgeschlossene Basisscan-Abdeckung.', limitations: ['Für eine zusätzliche Runde liegen nicht genügend reale Nachweise vor.'], suggestedNextStep: 'Nutzen Sie die Basisergebnisse und bewerten Sie bei neuen Nachweisen erneut.' }),
    AI_UNAVAILABLE: (subject) => ({ summary: `Der AI-Berater war nicht verfügbar; die ${subject}-Basisstrategie bleibt unverändert.`, coverageNarrative: 'Es wurde nur die reale Basisscan-Abdeckung verwendet.', limitations: ['Keine AI-Interpretation verfügbar; keine adaptive Runde vorgeschlagen.'], suggestedNextStep: 'Prüfen Sie die Basisergebnisse und entscheiden Sie über eine zusätzliche Runde.' }),
  },
  fr: {
    NOT_RUN: (subject) => ({ summary: `${subject} n'a pas été exécuté pendant cette analyse ; aucune base réelle ne permet un cycle adaptatif.`, coverageNarrative: "Aucune couverture vérifiée du cycle de base n'est encore disponible.", limitations: ["Une recommandation adaptative ne peut pas être produite avant la fin du cycle de base."], suggestedNextStep: "Exécutez d'abord le cycle de base puis réévaluez ses résultats réels." }),
    NO_EVIDENCE: (subject) => ({ summary: `Aucun constat ou observation réel ne justifie un cycle adaptatif ${subject}.`, coverageNarrative: "Seule la couverture terminée de l'analyse de base a été évaluée.", limitations: ["Les preuves réelles sont insuffisantes pour recommander un cycle supplémentaire."], suggestedNextStep: "Utilisez les résultats de base et réévaluez si de nouvelles preuves apparaissent." }),
    AI_UNAVAILABLE: (subject) => ({ summary: `Le conseiller AI était indisponible ; la stratégie de base ${subject} reste inchangée.`, coverageNarrative: "Seule la couverture réelle de l'analyse de base a été utilisée.", limitations: ["Interprétation AI indisponible ; aucun cycle adaptatif proposé."], suggestedNextStep: "Examinez les résultats de base et décidez si un cycle supplémentaire est approprié." }),
  },
  ar: {
    NOT_RUN: (subject) => ({ summary: `لم يُشغّل ${subject} في هذا الفحص؛ ولا يوجد أساس حقيقي لجولة تكيفية.`, coverageNarrative: 'لا تتوفر بعد تغطية متحققة للجولة الأساسية.', limitations: ['لا يمكن إنتاج توصية تكيفية قبل اكتمال الجولة الأساسية.'], suggestedNextStep: 'شغّل الجولة الأساسية أولاً ثم أعد تقييم نتائجها الحقيقية.' }),
    NO_EVIDENCE: (subject) => ({ summary: `لا توجد نتائج أو ملاحظات حقيقية تبرر جولة ${subject} تكيفية.`, coverageNarrative: 'تم تقييم تغطية الفحص الأساسي المكتملة فقط.', limitations: ['لا توجد أدلة حقيقية كافية للتوصية بجولة إضافية.'], suggestedNextStep: 'استخدم النتائج الأساسية وأعد التقييم عند توفر أدلة جديدة.' }),
    AI_UNAVAILABLE: (subject) => ({ summary: `تعذر استخدام مستشار AI؛ وتبقى استراتيجية ${subject} الأساسية دون تغيير.`, coverageNarrative: 'تم استخدام تغطية الفحص الأساسي الحقيقية فقط.', limitations: ['تعذر تفسير AI؛ ولم تُقترح جولة تكيفية.'], suggestedNextStep: 'راجع النتائج الأساسية وقرر كمستخدم ما إذا كانت الجولة الإضافية مناسبة.' }),
  },
};

export function advisorFallback(language: string, reason: FallbackReason, subject: string): AdvisorNarrative {
  return FALLBACK_COPY[normalizeAdvisorLanguage(language)][reason](subject);
}

export const ADVISOR_NARRATIVE_PROMPT = `
Return an assessment object containing only explanatory narrative:
- summary: a concise 1-2 sentence evidence-bound summary.
- coverageNarrative: explain what the supplied real execution covered.
- limitations: 1-8 concrete limits; never claim that zero findings proves safety.
- suggestedNextStep: one non-binding, concrete next step.
Do not return verdict, finding identity, scores, engine identity, capability identity or evidence; BCI derives those immutable facts itself.
`;
