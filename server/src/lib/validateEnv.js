import { logger } from './logger.js';

// Non-fatal startup check: logs one consolidated summary of which
// commonly-needed env vars are unset, so a misconfiguration is visible in
// the boot log instead of only surfacing later as a runtime error on
// whatever feature first needs the missing var. Nothing here is enforced --
// every one of these already fails gracefully on its own (DB disabled, AI
// provider skipped, email disabled, etc.) by design, documented per-var in
// .env.example. JWT_SECRET is the one hard requirement and is already
// enforced separately (see lib/jwtSecret.js, which throws in production).
const RECOMMENDED_VARS = [
  { name: 'DATABASE_URL', note: 'DB features disabled' },
  { name: 'RESEND_API_KEY', note: 'approval/notification emails disabled' },
  { name: 'ANTHROPIC_API_KEY', note: 'Claude AI provider unavailable' },
  { name: 'GEMINI_API_KEY', note: 'Gemini AI provider unavailable' },
  { name: 'OPENAI_API_KEY', note: 'GPT AI provider unavailable' },
  { name: 'SHARED_PASSWORD', note: 'legacy user seed skipped on first boot' },
  { name: 'GITHUB_TOKEN', note: 'Android/desktop update check will fail if the repo is private' },
  { name: 'BCI_BASE_URL', note: 'Cyber Analysis (BCI) module unavailable' },
  { name: 'BCI_GATEWAY_SECRET', note: 'Cyber Analysis (BCI) module unavailable' },
];

export function logEnvValidationWarnings() {
  const missing = RECOMMENDED_VARS.filter((v) => !process.env[v.name]);
  if (!missing.length) return;
  logger.warn(
    { missing: missing.map((v) => v.name) },
    `[Startup] ${missing.length} recommended env var(s) not set: ` +
    missing.map((v) => `${v.name} (${v.note})`).join('; ')
  );
}
