// Verification Engine v1 (spec section 23-24). Deterministic and versioned:
// bump VERIFICATION_MODEL_VERSION whenever this logic changes, so an old
// Finding's verification_status stays explainable against the model
// version that actually produced it (spec section 63).
export const VERIFICATION_MODEL_VERSION = 1;

const LIVE_CONFIRMING_CATEGORIES = new Set(['WEB', 'API', 'NETWORK_DISCOVERY']);
const NOISY_SINGLE_SOURCE_CATEGORIES = new Set(['SECRETS']);

// observations: the normalized_observations currently backing one Finding.
export function computeVerificationStatus(observations) {
  if (observations.length === 0) return 'UNVERIFIED';

  // An active engine (Nuclei's matcher already ran against the live target;
  // naabu directly observed the port) has already done a safe, live check
  // as part of detection itself -- that already IS the verification step
  // for these categories, not just a raw report to be re-checked later.
  if (observations.some((o) => LIVE_CONFIRMING_CATEGORIES.has(o.category))) {
    return 'CONFIRMED';
  }

  const distinctEngines = new Set(observations.map((o) => o.engine_id));

  // Two or more independent engines agreeing on the same underlying issue
  // (they only got here because Correlation already matched them into one
  // Finding) is treated as sufficient corroboration for static findings too.
  if (distinctEngines.size >= 2) {
    return 'CONFIRMED';
  }

  // Secret detectors are the category spec section 18 singles out as
  // needing extra false-positive scrutiny -- a lone secrets hit goes to a
  // human rather than being auto-trusted at any confidence level.
  if (observations.some((o) => NOISY_SINGLE_SOURCE_CATEGORIES.has(o.category))) {
    return 'MANUAL_REVIEW_REQUIRED';
  }

  // A single static-analysis engine's own, unconfirmed report.
  return 'LIKELY';
}
