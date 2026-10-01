import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import pinoHttp from 'pino-http';
import { fileURLToPath } from 'url';
import { logger } from './lib/logger.js';
import { logEnvValidationWarnings } from './lib/validateEnv.js';
import { attachSentryErrorHandler } from './lib/sentry.js';
import { initDatabase, initMemoryTables, query } from './services/database.js';
import { ensureDecisionTables, purgeExpiredDecisionRecords } from './services/decisionIntelligence.js';
import { ensureQuantumJobTables, startQuantumJobWorker } from './services/quantumJobQueue.js';
import { setDbReady } from './services/dbReadiness.js';
import { initSocketHandlers } from './services/socket.js';
import { requestMetricsMiddleware } from './lib/requestMetrics.js';
import { analysisTraceMiddleware } from './middleware/analysisTrace.js';
import authRoutes from './routes/auth.js';
import analysisRoutes from './routes/analysis.js';
import emergencyRoutes from './routes/emergency.js';
import historyRoutes from './routes/history.js';
import voiceRoutes from './routes/voice.js';
import memoryRoutes from './routes/memory.js';
import filesRoutes from './routes/files.js';
import weatherRoutes from './routes/weather.js';
import platformRoutes from './routes/platform.js';
import syncRoutes from './routes/sync.js';
import deviceRoutes from './routes/devices.js';
import webauthnRoutes from './routes/webauthn.js';
import wellKnownRoutes from './routes/wellKnown.js';
import versionRoutes from './routes/version.js';
import healthRoutes from './routes/health.js';
import cyberAnalysisRoutes from './routes/cyberAnalysis.js';
import sfreRoutes from './routes/sfre.js';
import { startMorningBriefScheduler } from './services/morningBrief.js';

// .env is loaded by instrument.js, preloaded via node/tsx's --import flag
// (see package.json's start/dev scripts) -- that happens before this file's
// own imports run, whereas dotenv.config() called here would run after them
// (ES module imports, including this file's route imports that read
// process.env.*_API_KEY at their own top level, are fully evaluated before
// any of this file's top-level statements execute).

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The desktop (Electron) and mobile (Capacitor) apps load the SPA from a
// local origin that is never the deployed backend origin, so their API/
// socket calls are cross-origin even though they're the same app -- see
// desktop/main.js's STATIC_SERVER_PORT and client/src/services/api.js's
// baseFor(). These fixed origins must always be allowlisted, in addition to
// APP_URL, regardless of environment.
const NATIVE_APP_ORIGINS = [
  'http://127.0.0.1:57813', // Electron desktop static server (desktop/main.js)
  'capacitor://localhost',  // Capacitor Android WebView
  'https://localhost',      // Capacitor Android WebView (some configs)
  'http://localhost',       // Capacitor Android WebView (cleartext, some configs)
];

// In production, restrict cross-origin access to the app's own deployed
// origin (APP_URL) plus the native app origins above, instead of reflecting
// any origin. Locally (no APP_URL / non-production) all origins are still
// allowed for developer convenience.
//
// The comment above described this as production-gated from the start, but
// the code itself never actually checked NODE_ENV -- APP_URL going unset in
// a REAL production deploy (a plausible ops mistake, not just a local dev
// default) silently fell through to allow-all-origins with credentials:true
// (the httpOnly session cookie riding along), rather than failing closed.
// Same fail-fast timing/pattern as lib/jwtSecret.js and this file's own
// DATABASE_CA_CERT check: refuse to start rather than silently widen CORS.
if (process.env.NODE_ENV === 'production' && !process.env.APP_URL) {
  throw new Error('APP_URL ortam değişkeni tanımlanmamış — üretimde zorunludur (aksi halde CORS tüm kökenlere açılır).');
}
const allowedOrigins = process.env.APP_URL ? [process.env.APP_URL, ...NATIVE_APP_ORIGINS] : true;

logEnvValidationWarnings();

const app = express();
// The deployment platform's reverse proxy terminates TLS upstream and
// forwards plain HTTP internally -- without this, req.protocol always reads
// back 'http' regardless of what the client actually connected over, which
// leaked into routes/version.js's self-referential download URLs as an
// insecure http:// address (the client apps then failed to open/fetch it).
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: allowedOrigins, methods: ['GET', 'POST'], credentials: true },
  pingTimeout: 60000,
  pingInterval: 25000
});

// credentials: true is required for the browser to attach the httpOnly
// session cookie (see lib/cookies.js) to cross-origin requests -- and,
// combined with `origin` never being the literal wildcard '*' above, is
// what makes that cookie flow at all (browsers refuse Access-Control-Allow-
// Credentials with a wildcard origin).
app.use(cors({ origin: allowedOrigins, credentials: true }));
// Audited against the actual Vite production build (client/dist/index.html)
// and every external-origin reference in client/src before enabling:
// - No inline <script> tags and no eval()/new Function() anywhere in the
//   client -- scriptSrc can stay 'self'-only, no 'unsafe-inline'/'unsafe-eval'.
// - Google Fonts CSS + font files (index.html <link> tags) -- styleSrc needs
//   fonts.googleapis.com, fontSrc needs fonts.gstatic.com.
// - React inline `style={{...}}` props (13 components) count as inline
//   styles under CSP -- styleSrc needs 'unsafe-inline' (CSS injection is a
//   much lower-severity vector than script injection, so this is a
//   reasonable trade-off vs. a full nonce-based rewrite).
// - Planet/globe textures are self-hosted (client/public/textures/*.jpg),
//   no external image CDN.
// - Socket.IO connects back to this same origin (see socket.js) --
//   connectSrc needs ws:/wss: in addition to 'self' (some browsers don't
//   treat 'self' as covering a scheme change from https to wss).
// - EmergencyButton's WebRTC calling feature uses Google's public STUN
//   servers for ICE candidate gathering -- connectSrc must explicitly allow
//   the stun: scheme (a bare scheme-source token; a full "stun:host:port"
//   source is invalid CSP syntax and gets silently dropped by the browser)
//   or emergency video/audio calls silently stop connecting.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'", 'ws:', 'wss:', 'stun:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'self'"],
      formAction: ["'self'"],
    },
  },
}));
app.use(pinoHttp({
  logger,
  // Authorization headers (raw JWTs) must never land in log output.
  redact: ['req.headers.authorization', 'res.headers["set-cookie"]'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(requestMetricsMiddleware);

// Lightweight liveness endpoint kept for external uptime monitors and
// backward compatibility with existing health checks.
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', uptime: process.uptime(), timestamp: Date.now() });
});
// BQI-004: separate liveness ("process is up") from readiness ("DB actually
// initialized") -- see routes/health.js. Mounted at the same /api/health
// prefix as the route above; Express only matches that route on the exact
// path, so /api/health/live and /api/health/ready fall through to this
// router without conflict.
app.use('/api/health', healthRoutes);

// API routes
app.use('/api/auth', authRoutes);
// Observe generation responses and persist provenance/evidence/decision trace
// without changing the established analysis route implementation or UX.
app.use('/api/analysis', analysisTraceMiddleware, analysisRoutes);
app.use('/api/emergency', emergencyRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/voice',
  express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '25mb' }),
  voiceRoutes
);
app.use('/api/memory', memoryRoutes);
app.use('/api/files', filesRoutes);
app.use('/api/weather', weatherRoutes);
app.use('/api/platform', platformRoutes);
// Versioned alias for new institutional/platform integrations. Existing API
// paths remain stable for current clients while new consumers can target v1.
app.use('/api/v1/platform', platformRoutes);
// Desktop/multi-device offline sync -- see routes/sync.js and desktop/sync/.
app.use('/api/sync', syncRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/webauthn', webauthnRoutes);
app.use('/api/version', versionRoutes);
// Proxies to the separately deployed BCI service -- see routes/cyberAnalysis.js
// and services/bciClient.js. Never reads BCI's database directly.
app.use('/api/sfre', sfreRoutes);
app.use('/api/cyber-analysis', cyberAnalysisRoutes);
app.use('/api/v1/cyber-analysis', cyberAnalysisRoutes);
// Not under /api -- Android's Credential Manager fetches this exact path
// itself (https://<rpId>/.well-known/assetlinks.json), it is not something
// this app's own client ever calls. See routes/wellKnown.js.
app.use('/.well-known', wellKnownRoutes);

// Socket.IO handlers
initSocketHandlers(io);
app.set('io', io);

// After all routes — forwards uncaught errors to Sentry (no-op if SENTRY_DSN is unset)
attachSentryErrorHandler(app);

// Production: serve React build
if (process.env.NODE_ENV === 'production') {
  const clientBuildPath = path.join(__dirname, '../../client/dist');
  app.use(express.static(clientBuildPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientBuildPath, 'index.html'));
  });
}

const PORT = process.env.PORT || 10000;

// The HTTP port is opened immediately, independent of DB startup, so a slow
// or unreachable database never delays (or fails) the platform's readiness
// probe -- DB-backed routes already guard on isDbConfigured()/getDb() being
// null and degrade gracefully until initDatabase() below resolves.
server.listen(PORT, () => {
  logger.info({ port: PORT }, 'BQI server running');
});

initDatabase()
  .then(() => initMemoryTables())
  .then(() => ensureDecisionTables())
  .then(() => ensureQuantumJobTables())
  .then(() => {
    startMorningBriefScheduler();
    startQuantumJobWorker(io);
    purgeExpiredDecisionRecords().catch((err) => logger.warn({ err }, 'Decision retention sweep failed'));
    const retentionTimer = setInterval(() => {
      purgeExpiredDecisionRecords().catch((err) => logger.warn({ err }, 'Decision retention sweep failed'));
    }, 6 * 60 * 60 * 1000);
    retentionTimer.unref();

    // Keeps one pooled connection to the (cross-cloud, server-on-Northflank
    // / DB-on-Render) Postgres instance alive between requests. The pool's
    // idleTimeoutMillis (see database.js) closes a connection after 30s of
    // no queries -- logins are infrequent enough that every one was paying
    // for a brand new TCP+TLS+auth handshake to the DB, which is what made
    // even the admin login path (no email step, so this was the whole
    // delay) take several seconds. Pinging well inside that 30s window
    // keeps a warm connection around so a login never has to pay for it.
    const dbKeepAliveTimer = setInterval(() => {
      query('SELECT 1').catch((err) => logger.warn({ err }, 'DB keep-alive ping failed'));
    }, 20 * 1000);
    dbKeepAliveTimer.unref();

    setDbReady(true);
    logger.info('Database ready');
  })
  .catch(err => {
    logger.error({ err }, 'Database initialization failed — continuing without DB');
  });
