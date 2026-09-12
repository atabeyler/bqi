import express from 'express';
import { isDbReady } from '../services/dbReadiness.js';

const router = express.Router();

// Liveness: the Node process is up and able to handle a request at all.
// Never depends on the database -- a DB outage must not make an
// orchestrator (Kubernetes, Northflank, ...) kill and restart an otherwise
// healthy process, which would just repeat the outage.
router.get('/live', (_req, res) => {
  res.json({ status: 'OK' });
});

// Readiness: the database has actually finished initializing (see
// server/src/index.js -- the HTTP port opens before DB init completes).
// Deliberately returns no DB credential/host/topology details in the
// response body -- only a boolean-shaped status -- since this endpoint is
// unauthenticated.
router.get('/ready', (_req, res) => {
  if (!isDbReady()) {
    return res.status(503).json({ status: 'NOT_READY' });
  }
  res.json({ status: 'OK' });
});

export default router;
