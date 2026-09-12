import 'dotenv/config';
import { validateEnv } from './lib/validateEnv.js';

validateEnv();

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 8081,
  databaseUrl: process.env.BCI_DATABASE_URL || 'postgres://bci:bci@localhost:5432/bci',
  databaseCaCert: process.env.BCI_DATABASE_CA_CERT || '',
  allowedOrigins: (process.env.BCI_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  logLevel: process.env.LOG_LEVEL || 'info',
  engineHealthMode: process.env.BCI_ENGINE_HEALTH_MODE || 'LOCAL',
  engineHealthStaleMs: Number(process.env.BCI_ENGINE_HEALTH_STALE_MS) || 15 * 60 * 1000,
  jwtSecret: process.env.BCI_JWT_SECRET || (process.env.NODE_ENV !== 'production' ? 'dev-only-insecure-secret' : ''),
  jwtTtlSeconds: Number(process.env.BCI_JWT_TTL_SECONDS) || 14400,
  // M14: BQI (or any other future gateway) trust boundary. Deliberately
  // a DIFFERENT secret from jwtSecret above -- a leak of one must never
  // compromise the other, and only a caller who knows this secret can mint a
  // gateway session at all (see routes/gateway.js).
  gatewaySecret: process.env.BCI_GATEWAY_SECRET || '',
  gatewayOrgSlug: process.env.BCI_GATEWAY_ORG_SLUG || 'bqi',
  gatewaySessionTtlSeconds: Number(process.env.BCI_GATEWAY_SESSION_TTL_SECONDS) || 900,
  engineBins: {
    trivy: process.env.BCI_TRIVY_BIN || 'trivy',
    osvScanner: process.env.BCI_OSV_SCANNER_BIN || 'osv-scanner',
    semgrep: process.env.BCI_SEMGREP_BIN || 'semgrep',
    nuclei: process.env.BCI_NUCLEI_BIN || 'nuclei',
    naabu: process.env.BCI_NAABU_BIN || 'naabu',
    sshKeyscan: process.env.BCI_SSH_KEYSCAN_BIN || 'ssh-keyscan',
  },
  // AI Decision Support (spec section 41-43): AI_DISABLED is the safe
  // default -- BCI's own security analysis never depends on it being
  // configured. EXTERNAL_AI requires an API key; LOCAL_AI/PRIVATE_AI are
  // reserved for a future on-prem/local-model provider, not implemented yet.
  aiMode: process.env.BCI_AI_MODE || 'AI_DISABLED',
  anthropicApiKey: process.env.BCI_ANTHROPIC_API_KEY || '',
  controlledProof: {
    publicProviderOrder: (process.env.BCI_CONTROLLED_PROOF_PUBLIC_PROVIDER_ORDER || '')
      .split(',').map((value) => value.trim()).filter(Boolean),
    publicTargets: (() => {
      try {
        const value = JSON.parse(process.env.BCI_CONTROLLED_PROOF_PUBLIC_TARGETS || '{}');
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      } catch {
        return {};
      }
    })(),
    cloudflareApiToken: process.env.BCI_CONTROLLED_PROOF_CLOUDFLARE_API_TOKEN || '',
    cloudflareTargets: (() => {
      try {
        const value = JSON.parse(process.env.BCI_CONTROLLED_PROOF_CLOUDFLARE_TARGETS || '{}');
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      } catch {
        return {};
      }
    })(),
  },
  // Quantum Compute Gateway (spec section 5-6). Quantum is always optional
  // -- BCI_IBM_QUANTUM_TOKEN unset means the IBM provider reports
  // NOT_CONFIGURED and every other provider (classical, quantum-inspired,
  // local simulator) keeps working. The token is read here, from env, and
  // nowhere else -- never persisted to the database, never logged.
  quantum: {
    // Accept the BQI runtime names as compatibility aliases. BCI_*
    // remains canonical, but a shared deployment must not silently discard
    // an already configured IBM Quantum secret.
    ibmToken: process.env.BCI_IBM_QUANTUM_TOKEN || process.env.IBM_QUANTUM_TOKEN || '',
    ibmInstance: process.env.BCI_IBM_QUANTUM_INSTANCE || process.env.IBM_QUANTUM_INSTANCE || '',
  },
  bootstrap: {
    orgName: process.env.BCI_BOOTSTRAP_ORG_NAME || '',
    adminEmail: process.env.BCI_BOOTSTRAP_ADMIN_EMAIL || '',
    adminPassword: process.env.BCI_BOOTSTRAP_ADMIN_PASSWORD || '',
  },
};

export const isProduction = config.nodeEnv === 'production';
