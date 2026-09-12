/**
 * BQI Option / Course-of-Action Comparison (BQI-017)
 *
 * General strategic/operational option comparison -- explicitly NOT a
 * weapons-targeting or autonomous-strike selection system. Produces a
 * structured comparison across benefit/cost/time/resource/legal-regulatory
 * risk/operational risk/secondary-effects/uncertainty/evidence-quality for
 * each option a caller supplies, plus a separate, clearly-labeled AI
 * recommendation. `humanDecision` always starts unset here -- this module
 * never writes it; a human decision-maker's actual choice is a separate,
 * later action (outside this module's scope) never conflated with the AI's
 * suggestion.
 *
 * Goes through generateStructured() (aiGenerate.ts), so it is subject to
 * the same data-egress policy as every other AI call path -- a RESTRICTED
 * comparison request can no more reach a cloud provider than a RESTRICTED
 * analysis could.
 */
import { z } from 'zod';
import { generateStructured } from './ai.js';

const optionScoreSchema = z.object({
  optionId: z.string(),
  benefit: z.string(),
  cost: z.string(),
  time: z.string(),
  resourceRequirement: z.string(),
  legalRegulatoryRisk: z.string(),
  operationalRisk: z.string(),
  secondaryEffects: z.string(),
  uncertainty: z.string(),
  evidenceQuality: z.enum(['low', 'medium', 'high']),
});

const coaComparisonSchema = z.object({
  options: z.array(optionScoreSchema),
  // A suggestion, never a decision -- see this file's module comment and
  // the CoaComparisonResult type below, which keeps this structurally
  // separate from `humanDecision`.
  aiRecommendation: z.object({
    optionId: z.string().nullable(),
    rationale: z.string(),
  }),
});

export type CoaOptionScore = z.infer<typeof optionScoreSchema>;

export interface CoaOptionInput {
  id: string;
  title: string;
  description?: string;
}

export interface CoaComparisonResult {
  options: CoaOptionScore[];
  aiRecommendation: { optionId: string | null; rationale: string };
  // Always null from this module -- a real choice is recorded by whatever
  // human-facing workflow calls this, never inferred or defaulted here.
  humanDecision: null;
  provider?: string;
}

const SYSTEM_PROMPT = `Sen BQI'nın stratejik/operasyonel SEÇENEK (course of action) KARŞILAŞTIRMA analistisin.
Bu bir silah hedefleme veya otonom saldırı karar sistemi DEĞİLDİR -- yalnızca insan karar vericiye sunulacak karşılaştırmalı bir değerlendirme üretiyorsun.

Her seçenek için şu boyutları KISA ve SOMUT biçimde doldur:
- benefit (fayda), cost (maliyet), time (süre), resourceRequirement (kaynak ihtiyacı)
- legalRegulatoryRisk (hukuki/mevzuat riski), operationalRisk (operasyonel risk)
- secondaryEffects (ikincil etkiler), uncertainty (belirsizlik)
- evidenceQuality: "low" | "medium" | "high" -- bu değerlendirmeyi destekleyen kanıtın güvenilirliği

Son olarak aiRecommendation alanında HANGİ seçeneğe eğilimli olduğunu ve NEDEN olduğunu kısaca yaz.
Bu bir ÖNERİDİR, NİHAİ KARAR DEĞİLDİR -- nihai kararı insan verir.`;

export async function generateCoaComparison(
  topic: string,
  options: CoaOptionInput[],
  classification: string = 'INTERNAL'
): Promise<CoaComparisonResult> {
  if (!Array.isArray(options) || options.length < 2) {
    throw new Error('En az 2 seçenek karşılaştırılmalı');
  }

  const userPrompt = `Konu: ${topic}\n\nSeçenekler:\n${options
    .map((o, i) => `${i + 1}. [id: ${o.id}] ${o.title}${o.description ? ` -- ${o.description}` : ''}`)
    .join('\n')}`;

  const result = await generateStructured(SYSTEM_PROMPT, userPrompt, coaComparisonSchema, classification, 'coaComparison');
  return { ...result, humanDecision: null };
}
