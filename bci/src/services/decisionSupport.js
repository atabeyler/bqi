import { query } from '../db/client.js';
import { getActiveProvider } from '../ai/registry.js';
import { redactForExternalAi } from '../ai/dlp.js';
import { recordAuditEvent } from './audit.js';

// The deterministic, always-available explanation. This is what a caller
// gets when AI is disabled, misconfigured, or its call fails -- BCI's own
// analysis (spec section 41: "AI önemli olacaktır ancak güvenlik otoritesi
// olmayacaktır") never depends on this succeeding.
function deterministicFallbackSummary(finding) {
  const parts = [
    `${finding.title} on ${finding.target}.`,
    finding.risk_score != null ? `BCI Risk Score: ${finding.risk_score}/100 (${finding.priority}).` : null,
    `Confidence: ${finding.confidence_score}/100 (${finding.verification_status}).`,
    finding.cve_ids?.length ? `Related CVEs: ${finding.cve_ids.join(', ')}.` : null,
  ];
  return parts.filter(Boolean).join(' ');
}

function buildPrompt(finding) {
  const raw = [
    `Explain the following security finding in plain language for a non-technical reader, in 2-3 sentences.`,
    `Title: ${finding.title}`,
    `Category: ${finding.category}`,
    `Target: ${finding.target}`,
    `CVEs: ${finding.cve_ids?.join(', ') || 'none'}`,
    `BCI Risk Score: ${finding.risk_score ?? 'n/a'}/100, Priority: ${finding.priority ?? 'n/a'}`,
    `Confidence: ${finding.confidence_score}/100 (${finding.verification_status})`,
  ].join('\n');
  return redactForExternalAi(raw);
}

export async function explainFinding(orgId, actorUserId, finding) {
  const provider = getActiveProvider();

  try {
    const health = await provider.healthCheck();
    if (health.status !== 'HEALTHY') throw new Error(health.detail || 'provider unavailable');

    const { text } = await provider.generate({ prompt: buildPrompt(finding) });
    await recordAuditEvent({
      orgId, actorUserId, action: 'ai.explain_finding', targetType: 'finding', targetId: finding.id,
      result: 'SUCCESS', metadata: { provider: provider.id, mode: provider.mode },
    });
    return { text, source: 'ai', provider: provider.id };
  } catch (err) {
    await recordAuditEvent({
      orgId, actorUserId, action: 'ai.explain_finding', targetType: 'finding', targetId: finding.id,
      result: 'FAILURE', metadata: { provider: provider.id, reason: String(err.message || err) },
    });
    return { text: deterministicFallbackSummary(finding), source: 'deterministic' };
  }
}

// Hallucination control (spec section 42): "AI yorumlar; kanıt doğrular."
// An AI-generated claim of active exploitation is never taken as fact --
// it's checked against BCI's own intelligence knowledge base (M8), and
// only reported as confirmed if that base actually backs it up.
export async function verifyExploitationClaim(cveId) {
  const { rows } = await query('SELECT kev FROM vulnerabilities WHERE cve_id = $1', [cveId]);
  if (rows.length === 0) return { status: 'UNVERIFIED', reason: 'no local intelligence for this CVE' };
  return rows[0].kev
    ? { status: 'CONFIRMED', reason: 'listed in CISA KEV' }
    : { status: 'UNVERIFIED', reason: 'not listed in CISA KEV; claim not independently corroborated' };
}
