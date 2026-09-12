/**
 * BQI Central Data-Egress / AI Provider Policy (BQI-001 / BQI-014)
 *
 * A user's authorization to *view* data at a given classification
 * (server/src/lib/rbac.js's canAccessClassification) is a separate concern
 * from whether that data may be *sent to an external cloud AI provider*.
 * This module is the single source of truth for the second question, and
 * every call path that talks to Claude/Gemini/OpenAI (normal analysis,
 * streaming, voice, document analysis, research-grounded generation,
 * fallback, red-team) must go through it before invoking a provider
 * adapter -- see aiGenerate.ts, routes/voice.js.
 *
 * Policy (fixed, not admin-configurable beyond the documented escape hatch
 * below):
 *   PUBLIC        -> any configured cloud provider allowed
 *   INTERNAL      -> only the approved cloud provider set (APPROVED_CLOUD_PROVIDERS)
 *   CONFIDENTIAL  -> only the approved cloud provider set (APPROVED_CLOUD_PROVIDERS),
 *                    same as INTERNAL -- no operator opt-in required
 *   RESTRICTED    -> cloud is never allowed, unconditionally, no override
 *
 * Fails closed: an unrecognized/missing classification is treated as
 * RESTRICTED (deny), never as PUBLIC/INTERNAL (allow).
 */
import { logger } from '../lib/logger.js';

export const CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export class PolicyDenialError extends Error {
  code = 'DATA_EGRESS_POLICY_DENIED';
  status = 403;
}

function approvedCloudProviders(): Set<string> {
  const raw = process.env.APPROVED_CLOUD_PROVIDERS;
  // Unset preserves this project's existing behavior (all three configured
  // providers are "approved") -- an operator narrows this explicitly via
  // env, this module never widens it on its own.
  const list = raw ? raw.split(',') : ['claude', 'gemini', 'openai'];
  return new Set(list.map((s) => s.trim().toLowerCase()).filter(Boolean));
}

// The actual policy decision -- pure function, no I/O, so it's trivially
// unit-testable independent of env-var setup elsewhere.
export function isCloudProviderAllowed(classification: string | null | undefined, providerKey: string): boolean {
  const cls = (classification || '').toUpperCase();
  const key = (providerKey || '').toLowerCase();

  switch (cls) {
    case 'PUBLIC':
      return true;
    case 'INTERNAL':
    case 'CONFIDENTIAL':
      return approvedCloudProviders().has(key);
    case 'RESTRICTED':
      return false; // unconditional -- no env/config can ever flip this true
    default:
      // Unknown/missing classification -- fail closed rather than assume
      // the least-sensitive level.
      return false;
  }
}

export function logPolicyDenial({ classification, provider, route, reason }: {
  classification?: string | null; provider: string; route: string; reason: string;
}) {
  logger.warn(
    { audit: 'data_egress_policy_denial', classification: classification || null, provider, route, reason },
    '[DataEgressPolicy] cloud AI provider call denied'
  );
}

// Used by call sites that loop over an ordered candidate list (generateAnalysis's
// pickProviderOrder(), streamConsultationText's fixed attempts array) --
// strips out anything the policy forbids and audit-logs each exclusion,
// rather than trying-then-catching a provider that should never have been
// dialed in the first place.
export function filterAllowedProviders<T extends { key: string }>(
  classification: string | null | undefined,
  providers: T[],
  route: string
): T[] {
  const allowed: T[] = [];
  for (const p of providers) {
    if (isCloudProviderAllowed(classification, p.key)) {
      allowed.push(p);
    } else {
      logPolicyDenial({ classification, provider: p.key, route, reason: 'classification_forbids_cloud_provider' });
    }
  }
  return allowed;
}

// Used by call sites that check one provider at a time (parseVoiceIntent's
// sequential if-blocks, routes/voice.js's direct OpenAI calls). Throws
// (fail closed) rather than returning a boolean, so a caller can't
// accidentally ignore a denial and proceed anyway.
export function assertProviderAllowed(classification: string | null | undefined, providerKey: string, route: string): void {
  if (isCloudProviderAllowed(classification, providerKey)) return;
  logPolicyDenial({ classification, provider: providerKey, route, reason: 'classification_forbids_cloud_provider' });
  throw new PolicyDenialError(
    `Bu veri sınıfı (${classification || 'bilinmiyor'}) için ${providerKey} sağlayıcısına veri gönderilemez -- politika reddi`
  );
}
