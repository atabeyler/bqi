import { z } from 'zod';
import { generateStructuredWithMetadata } from './aiGenerate.js';
import { UNTRUSTED_EVIDENCE_POLICY, wrapUntrustedEvidence } from './aiPrompts.js';
import { deriveAdvisorVerdict } from './bciAdvisorAssessment.js';

type EngineRun = { engine_id: string; status: string; observation_count?: number | null; detail?: string | null };
type ScanJob = {
  id: string; target: string; target_type?: string; requested_class?: string; status: string;
  result?: {
    recommendedCapabilities?: string[]; selectedCapabilities?: string[]; actualExecutedCapabilities?: string[];
    recommendedEngines?: string[]; selectedEngines?: string[]; enginesRun?: string[];
    enginesSkipped?: Array<{ engineId: string; reason: string }>; findingIds?: string[];
  } | null;
};
type FindingSource = {
  engine_id?: string; capability_id?: string; scan_job_id?: string; observation_title?: string;
  engine_severity?: string | null; location?: string | null; evidence?: Record<string, unknown> | null;
};
type FindingEvidence = {
  id: string; title?: string; category?: string; target?: string; location?: string | null;
  risk_score?: number | null; priority?: string | null; confidence_score?: number | null;
  verification_status?: string | null; cve_ids?: string[]; cwe_ids?: string[]; sources?: FindingSource[];
};

const urgencySchema = z.enum(['IMMEDIATE', 'SHORT_TERM', 'MEDIUM_TERM']);

// Only interpretation is model-generated. Identity, scores, evidence,
// coverage and provenance are intentionally absent: BCI supplies those.
const aiAssessmentSchema = z.object({
  executiveSummary: z.string().min(1),
  coverageNarrative: z.string().min(1),
  findingInterpretations: z.array(z.object({
    findingId: z.string(), possibleImpact: z.string().min(1), recommendedAction: z.string().min(1),
    rationale: z.string().min(1), urgency: urgencySchema,
  })).max(20),
  riskSynthesis: z.object({
    overallAssessment: z.string().min(1), relatedFindingIds: z.array(z.string()).max(20),
    possibleCombinedImpact: z.string().min(1), uncertainty: z.string().min(1),
  }),
  actionPlan: z.array(z.object({
    order: z.number().int().positive(), action: z.string().min(1), rationale: z.string().min(1),
    relatedFindingIds: z.array(z.string()).max(20), urgency: urgencySchema, requiresUserApproval: z.literal(true),
  })).max(15),
  limitations: z.array(z.string()).min(1).max(12),
  conclusion: z.string().min(1),
});
type AiAssessment = z.infer<typeof aiAssessmentSchema>;

const LANGUAGE_NAMES: Record<string, string> = {
  tr: 'Turkish', en: 'English', de: 'German', fr: 'French', ar: 'Arabic',
};

const FALLBACK_COPY: Record<string, {
  noFinding: string; findings: (count: number, observations: number) => string; coverage: string;
  noImpact: string; action: string; rationale: string; synthesis: string; combined: string;
  uncertainty: string; limitation: string; conclusion: string;
}> = {
  tr: {
    noFinding: 'Seçilen ve fiilen çalıştırılan kapsam içinde doğrulanmış bulgu oluşmadı.',
    findings: (count, observations) => `${count} bulgu, ${observations} gerçek normalize gözleme dayanmaktadır.`,
    coverage: 'Değerlendirme yalnız fiilen çalışan motorlar ve capability kapsamıyla sınırlıdır.',
    noImpact: 'Kanıt dışı etki değerlendirmesi yapılmadı.',
    action: 'Bulgunun kanıtını inceleyin, uygun giderimi onaylayın ve düzeltme sonrası doğrulama taraması çalıştırın.',
    rationale: 'BCI önerir; giderim ve yeniden test kararı kullanıcıya aittir.',
    synthesis: 'Bulgular bağımsız olarak kanıt ve risk değerleriyle incelenmelidir.',
    combined: 'Kanıtlanmış bir birleşik etki belirlenmedi.',
    uncertainty: 'AI yorumu kullanılamadı; yalnız doğrulanmış BCI verileri gösteriliyor.',
    limitation: 'Bulgu bulunmaması hedefin tamamen güvenli olduğunu kanıtlamaz.',
    conclusion: 'Son karar kullanıcıya aittir; BCI yalnız kanıta bağlı öneri sunar.',
  },
  en: {
    noFinding: 'No verified finding was produced within the selected and actually executed scope.',
    findings: (count, observations) => `${count} findings are supported by ${observations} real normalized observations.`,
    coverage: 'This assessment is limited to the engines and capabilities that actually executed.',
    noImpact: 'No impact beyond the available evidence was inferred.',
    action: 'Review the evidence, approve the appropriate remediation, and run a verification scan after the fix.',
    rationale: 'BCI recommends; the remediation and retest decision belongs to the user.',
    synthesis: 'Review each finding against its evidence and risk value.',
    combined: 'No verified combined impact was established.',
    uncertainty: 'AI interpretation was unavailable; only verified BCI facts are shown.',
    limitation: 'No findings does not prove that the target is completely secure.',
    conclusion: 'The user makes the final decision; BCI provides evidence-bound recommendations.',
  },
  de: {
    noFinding: 'Im ausgewählten und tatsächlich ausgeführten Umfang wurde kein verifizierter Befund erzeugt.',
    findings: (count, observations) => `${count} Befunde basieren auf ${observations} realen normalisierten Beobachtungen.`,
    coverage: 'Diese Bewertung ist auf die tatsächlich ausgeführten Engines und Fähigkeiten beschränkt.',
    noImpact: 'Über die vorhandenen Nachweise hinaus wurde keine Auswirkung abgeleitet.',
    action: 'Prüfen Sie die Nachweise, genehmigen Sie die passende Behebung und führen Sie danach einen Verifizierungsscan aus.',
    rationale: 'BCI empfiehlt; die Entscheidung über Behebung und erneute Prüfung trifft der Benutzer.',
    synthesis: 'Jeder Befund ist anhand seiner Nachweise und Risikowerte zu prüfen.',
    combined: 'Es wurde keine verifizierte kombinierte Auswirkung festgestellt.',
    uncertainty: 'Die AI-Interpretation war nicht verfügbar; angezeigt werden nur verifizierte BCI-Fakten.',
    limitation: 'Das Fehlen von Befunden beweist nicht, dass das Ziel vollständig sicher ist.',
    conclusion: 'Die endgültige Entscheidung trifft der Benutzer; BCI liefert nachweisgebundene Empfehlungen.',
  },
  fr: {
    noFinding: "Aucun constat vérifié n'a été produit dans le périmètre sélectionné et réellement exécuté.",
    findings: (count, observations) => `${count} constats reposent sur ${observations} observations normalisées réelles.`,
    coverage: 'Cette évaluation est limitée aux moteurs et capacités réellement exécutés.',
    noImpact: "Aucun impact au-delà des preuves disponibles n'a été déduit.",
    action: 'Examinez les preuves, approuvez la correction appropriée et lancez une analyse de vérification après correction.',
    rationale: "BCI recommande ; la décision de correction et de nouveau test appartient à l'utilisateur.",
    synthesis: 'Chaque constat doit être examiné au regard de ses preuves et de son niveau de risque.',
    combined: "Aucun impact combiné vérifié n'a été établi.",
    uncertainty: "L'interprétation AI était indisponible ; seuls les faits BCI vérifiés sont affichés.",
    limitation: "L'absence de constat ne prouve pas que la cible est totalement sécurisée.",
    conclusion: "La décision finale appartient à l'utilisateur ; BCI fournit des recommandations fondées sur les preuves.",
  },
  ar: {
    noFinding: 'لم تُنتج نتائج مُتحقق منها ضمن النطاق المحدد والمنفذ فعلياً.',
    findings: (count, observations) => `تستند ${count} نتائج إلى ${observations} ملاحظات حقيقية ومطبّعة.`,
    coverage: 'يقتصر هذا التقييم على المحركات والقدرات التي نُفذت فعلياً.',
    noImpact: 'لم يُستنتج أي تأثير يتجاوز الأدلة المتاحة.',
    action: 'راجع الأدلة، واعتمد المعالجة المناسبة، ثم شغّل فحص تحقق بعد الإصلاح.',
    rationale: 'توصي BCI، بينما يعود قرار المعالجة وإعادة الاختبار إلى المستخدم.',
    synthesis: 'يجب مراجعة كل نتيجة وفق أدلتها وقيمة مخاطرها.',
    combined: 'لم يثبت وجود تأثير مركب.',
    uncertainty: 'تعذر تفسير AI؛ لذلك تُعرض حقائق BCI المتحقق منها فقط.',
    limitation: 'عدم وجود نتائج لا يثبت أن الهدف آمن بالكامل.',
    conclusion: 'القرار النهائي للمستخدم؛ وتقدم BCI توصيات مرتبطة بالأدلة.',
  },
};

function normalizedLanguage(language: string) { return Object.hasOwn(LANGUAGE_NAMES, language) ? language : 'tr'; }

function buildEvidence(job: ScanJob, engineRuns: EngineRun[], findings: FindingEvidence[]) {
  return {
    scanJobId: job.id, target: job.target, targetType: job.target_type ?? null,
    requestedClass: job.requested_class ?? null, status: job.status,
    recommendedCapabilities: job.result?.recommendedCapabilities ?? [],
    selectedCapabilities: job.result?.selectedCapabilities ?? [],
    actualExecutedCapabilities: job.result?.actualExecutedCapabilities ?? [],
    recommendedEngines: job.result?.recommendedEngines ?? [],
    selectedEngines: job.result?.selectedEngines ?? [],
    actualExecutedEngines: job.result?.enginesRun ?? [],
    enginesSkipped: job.result?.enginesSkipped ?? [],
    engineRuns: engineRuns.map((run) => ({
      engineId: run.engine_id, status: run.status,
      normalizedObservationCount: Number(run.observation_count || 0), detail: run.detail || null,
    })),
    findings: findings.map((finding) => ({
      id: finding.id, title: finding.title || finding.id, category: finding.category ?? null,
      target: finding.target ?? job.target, location: finding.location ?? null,
      riskScore: finding.risk_score ?? null, priority: finding.priority ?? null,
      confidenceScore: finding.confidence_score ?? null, verificationStatus: finding.verification_status ?? null,
      cveIds: finding.cve_ids ?? [], cweIds: finding.cwe_ids ?? [],
      sources: (finding.sources ?? []).map((source) => ({
        engineId: source.engine_id ?? null, capabilityId: source.capability_id ?? null,
        scanJobId: source.scan_job_id ?? job.id, observationTitle: source.observation_title ?? null,
        engineSeverity: source.engine_severity ?? null, location: source.location ?? null,
        evidence: source.evidence ?? null,
      })),
    })),
  };
}

function deterministicInterpretation(evidence: ReturnType<typeof buildEvidence>, language: string): AiAssessment {
  const copy = FALLBACK_COPY[normalizedLanguage(language)];
  const observations = evidence.engineRuns.filter((run) => run.status === 'COMPLETED')
    .reduce((sum, run) => sum + run.normalizedObservationCount, 0);
  return {
    executiveSummary: evidence.findings.length ? copy.findings(evidence.findings.length, observations) : copy.noFinding,
    coverageNarrative: copy.coverage,
    findingInterpretations: evidence.findings.map((finding) => ({
      findingId: finding.id, possibleImpact: copy.noImpact, recommendedAction: copy.action,
      rationale: copy.rationale, urgency: 'SHORT_TERM',
    })),
    riskSynthesis: {
      overallAssessment: copy.synthesis, relatedFindingIds: evidence.findings.map((finding) => finding.id),
      possibleCombinedImpact: copy.combined, uncertainty: copy.uncertainty,
    },
    actionPlan: evidence.findings.length ? [{
      order: 1, action: copy.action, rationale: copy.rationale,
      relatedFindingIds: evidence.findings.map((finding) => finding.id), urgency: 'SHORT_TERM', requiresUserApproval: true,
    }] : [],
    limitations: [copy.limitation, copy.coverage], conclusion: copy.conclusion,
  };
}

function sanitizeInterpretation(ai: AiAssessment, validFindingIds: Set<string>): AiAssessment {
  const validIds = (ids: string[]) => [...new Set(ids.filter((id) => validFindingIds.has(id)))];
  return {
    ...ai,
    findingInterpretations: ai.findingInterpretations.filter((item) => validFindingIds.has(item.findingId)),
    riskSynthesis: { ...ai.riskSynthesis, relatedFindingIds: validIds(ai.riskSynthesis.relatedFindingIds) },
    actionPlan: ai.actionPlan.map((item) => ({
      ...item, relatedFindingIds: validIds(item.relatedFindingIds), requiresUserApproval: true as const,
    })).sort((a, b) => a.order - b.order),
  };
}

function assembleReport(evidence: ReturnType<typeof buildEvidence>, interpretation: AiAssessment, fallback: AiAssessment) {
  const byFinding = new Map(interpretation.findingInterpretations.map((item) => [item.findingId, item]));
  const fallbackByFinding = new Map(fallback.findingInterpretations.map((item) => [item.findingId, item]));
  return {
    verdict: deriveAdvisorVerdict(evidence.findings, evidence.engineRuns.some((run) => run.status !== 'COMPLETED')),
    executiveSummary: interpretation.executiveSummary,
    coverage: {
      narrative: interpretation.coverageNarrative, target: evidence.target, targetType: evidence.targetType,
      requestedClass: evidence.requestedClass, recommendedCapabilities: evidence.recommendedCapabilities,
      selectedCapabilities: evidence.selectedCapabilities, actualExecutedCapabilities: evidence.actualExecutedCapabilities,
      recommendedEngines: evidence.recommendedEngines, selectedEngines: evidence.selectedEngines,
      actualExecutedEngines: evidence.actualExecutedEngines, enginesSkipped: evidence.enginesSkipped,
      engineRuns: evidence.engineRuns,
    },
    findings: evidence.findings.map((finding) => ({
      ...finding, interpretation: byFinding.get(finding.id) ?? fallbackByFinding.get(finding.id),
    })),
    riskSynthesis: interpretation.riskSynthesis, actionPlan: interpretation.actionPlan,
    limitations: interpretation.limitations, conclusion: interpretation.conclusion,
  };
}

function legacyText(report: ReturnType<typeof assembleReport>) {
  return [report.executiveSummary, report.riskSynthesis.overallAssessment, ...report.limitations, report.conclusion].join('\n\n');
}

export function deterministicBciAssessment(job: ScanJob, engineRuns: EngineRun[], findings: FindingEvidence[], language = 'tr') {
  const evidence = buildEvidence(job, engineRuns, findings);
  const interpretation = deterministicInterpretation(evidence, language);
  const report = assembleReport(evidence, interpretation, interpretation);
  return { text: legacyText(report), report, evidence };
}

export async function assessBciScan({ job, engineRuns, findings, dataClassification = 'INTERNAL', language = 'tr' }: {
  job: ScanJob; engineRuns: EngineRun[]; findings: FindingEvidence[]; dataClassification?: string; language?: string;
}) {
  const safeLanguage = normalizedLanguage(language);
  const evidence = buildEvidence(job, engineRuns, findings);
  const deterministic = deterministicInterpretation(evidence, safeLanguage);
  try {
    const generated = await generateStructuredWithMetadata(
      `You are the evidence-bound decision-support analyst for BOLD Cyber Intelligence.
Use only the supplied immutable BCI scan evidence. Never invent a finding, CVE, CWE, engine execution, capability, score, location, observation or evidence.
Write every narrative field in ${LANGUAGE_NAMES[safeLanguage]}.
Interpret impact as possible unless supplied evidence directly verifies it. A zero-finding result never proves the target is secure; limit it to actual execution coverage.
Every action is advisory and requires user approval. BCI RECOMMENDS. THE USER DECIDES. BCI EXECUTES AND EXPLAINS.
Return a concise, decision-ready professional assessment. ${UNTRUSTED_EVIDENCE_POLICY}`,
      wrapUntrustedEvidence('BCI SCAN EVIDENCE', JSON.stringify(evidence)),
      aiAssessmentSchema, dataClassification, 'assessBciScan',
    );
    const interpretation = sanitizeInterpretation(generated.object, new Set(evidence.findings.map((finding) => finding.id)));
    const report = assembleReport(evidence, interpretation, deterministic);
    return { text: legacyText(report), report, source: 'ai', provider: generated.realProvider, evidence };
  } catch {
    const report = assembleReport(evidence, deterministic, deterministic);
    return { text: legacyText(report), report, source: 'deterministic', provider: null, evidence };
  }
}
