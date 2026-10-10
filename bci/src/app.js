import express from 'express';
// Patches Express 4's router so a rejected promise from an async route
// handler reaches the error-handling middleware (app.use((err, req, res,
// next) => ...) below) instead of becoming an unhandled rejection that
// hangs the request and, on some Node versions, crashes the whole process.
// Must be imported before any router/route is registered. Fixes a real,
// verified crash: GET /api/v1/scans/:id with a malformed id previously hung
// the request and surfaced as an unhandled promise rejection in the pg
// driver (see test/secretSecurity.test.js).
import 'express-async-errors';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { config, isProduction } from './config.js';
import { logger } from './logger.js';
import { requestId } from './middleware/requestId.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { scopesRouter } from './routes/scopes.js';
import { auditRouter } from './routes/audit.js';
import { assetsRouter } from './routes/assets.js';
import { scansRouter } from './routes/scans.js';
import { enginesRouter } from './routes/engines.js';
import { observationsRouter } from './routes/observations.js';
import { findingsRouter } from './routes/findings.js';
import { intelligenceRouter } from './routes/intelligence.js';
import { riskRouter } from './routes/risk.js';
import { graphRouter } from './routes/graph.js';
import { reportsRouter } from './routes/reports.js';
import { gatewayRouter } from './routes/gateway.js';
import { quantumRouter } from './routes/quantum.js';
import { cryptoRouter } from './routes/crypto.js';
import { decisionRouter } from './routes/decision.js';
import { controlledProofRouter } from './routes/controlledProof.js';
import { pentestRouter } from './routes/pentest.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    })
  );
  app.use(helmet());

  // Fail closed in production: an unset allowlist means no browser origin is
  // trusted, mirroring BQI's CORS posture. Server-to-server callers
  // (e.g. the BQI backend) are not subject to this browser check.
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (!isProduction) return callback(null, true);
        if (config.allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('Not allowed by CORS'));
      },
      credentials: true,
    })
  );

  app.use(express.json({ limit: '2mb' }));

  app.use('/api/v1/health', healthRouter);
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/scopes', scopesRouter);
  app.use('/api/v1/audit', auditRouter);
  app.use('/api/v1/assets', assetsRouter);
  app.use('/api/v1/scans', scansRouter);
  app.use('/api/v1/engines', enginesRouter);
  app.use('/api/v1/observations', observationsRouter);
  app.use('/api/v1/findings', findingsRouter);
  app.use('/api/v1/intelligence', intelligenceRouter);
  app.use('/api/v1/risk', riskRouter);
  app.use('/api/v1/graph', graphRouter);
  app.use('/api/v1/reports', reportsRouter);
  app.use('/api/v1/gateway', gatewayRouter);
  app.use('/api/v1/quantum', quantumRouter);
  app.use('/api/v1/crypto', cryptoRouter);
  app.use('/api/v1/decision', decisionRouter);
  app.use('/api/v1/controlled-proof', controlledProofRouter);
  app.use('/api/v1/pentest', pentestRouter);

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', requestId: req.id });
  });

  app.use((err, req, res, _next) => {
    req.log?.error({ err }, 'Unhandled error');
    res.status(500).json({ error: 'internal_error', requestId: req.id });
  });

  return app;
}
