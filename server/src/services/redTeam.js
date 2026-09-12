/**
 * BQI Red-Team / Critique Pass (BQI-016)
 *
 * An independent second AI call that critiques an already-generated
 * analysis -- assumptions, counter-evidence, missing evidence, alternative
 * explanations, and failure modes -- without ever replacing or editing the
 * primary analysis. Opt-in (routes/analysis.js only calls this when the
 * request explicitly asks for it via `redTeamReview: true`) so existing
 * traffic's latency/cost is completely unaffected until a caller asks for
 * it.
 *
 * Goes through generateAnalysis(), so it's subject to the exact same
 * data-egress policy (dataEgressPolicy.js) as the primary analysis call --
 * a RESTRICTED analysis's red-team pass can no more reach a cloud provider
 * than the primary analysis could.
 */
import { generateAnalysis } from './ai.js';
import { logger } from '../lib/logger.js';

const CRITIQUE_SYSTEM_PROMPT = `Sen BQI'nın bağımsız kırmızı takım (red-team) eleştirmenisin.
Görevin, sana verilen analiz raporunu ÜRETMEK DEĞİL, ELEŞTİRMEK.
Ana analizin yerine geçecek yeni bir karar/öneri üretme -- yalnızca aşağıdaki başlıklar altında YAPISAL bir değerlendirme yaz:

1. VARSAYIMLAR (Assumptions): Raporun hangi açık/örtük varsayımlara dayandığı.
2. KARŞIT KANIT (Counter-evidence): Rapordaki sonuçla çelişebilecek veya onu zayıflatabilecek bilgiler.
3. EKSİK KANIT (Missing evidence): Sonuca varmak için gerekli olup raporda bulunmayan veri/bilgi.
4. ALTERNATİF AÇIKLAMALAR (Alternative explanations): Aynı verilerle savunulabilecek farklı yorumlar/sonuçlar.
5. BAŞARISIZLIK SENARYOLARI (Failure modes): Bu analize dayanarak alınacak bir kararın nasıl yanlış çıkabileceği.

Kısa, madde işaretli, somut yaz. Nihai kararı SEN vermiyorsun -- bu bir insan karar vericiye sunulacak bağımsız bir ikinci görüş.`;

export class RedTeamReviewError extends Error {
  code = 'RED_TEAM_REVIEW_FAILED';
}

/**
 * Returns { critique, provider } on success. Never throws for an ordinary
 * provider failure (mirrors routes/memory.js's summarization pattern) --
 * the caller decides what "no review available" means for its response
 * shape. Does throw PolicyDenialError/RedTeamReviewError-wrapped failures
 * upward only when the caller explicitly awaits with no try/catch, so
 * callers that want fail-closed behavior for a policy denial specifically
 * can still distinguish it via err.code.
 */
export async function runRedTeamReview(analysisContent, { category, classification = 'INTERNAL' } = {}) {
  if (!analysisContent || typeof analysisContent !== 'string') {
    throw new RedTeamReviewError('Eleştirilecek analiz içeriği boş');
  }

  const userPrompt = `Kategori: ${category || 'bilinmiyor'}\n\n[DEĞERLENDİRİLECEK ANALİZ RAPORU]\n${analysisContent}`;

  try {
    const result = await generateAnalysis(CRITIQUE_SYSTEM_PROMPT, userPrompt, {}, classification);
    return { critique: result.content, provider: result.provider };
  } catch (err) {
    // A policy denial (RESTRICTED/CONFIDENTIAL-without-override) must
    // propagate as-is so the caller can tell "cloud forbidden" apart from
    // "the provider actually failed" -- see dataEgressPolicy.js.
    if (err?.code === 'DATA_EGRESS_POLICY_DENIED') throw err;
    logger.warn({ err }, '[RedTeam] critique pass failed');
    throw new RedTeamReviewError(`Kırmızı takım incelemesi üretilemedi: ${err.message}`);
  }
}
