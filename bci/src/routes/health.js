import { Router } from 'express';
import { checkDatabaseHealth } from '../db/client.js';

export const healthRouter = Router();

// Liveness: process is up. Never checks dependencies — used by orchestrators
// to decide whether to restart the container.
healthRouter.get('/live', (_req, res) => {
  res.json({ status: 'ok' });
});

// Readiness: process is up AND able to serve traffic (DB reachable). Used by
// load balancers/orchestrators to decide whether to route traffic here.
healthRouter.get('/ready', async (_req, res) => {
  const dbHealthy = await checkDatabaseHealth();
  if (!dbHealthy) {
    return res.status(503).json({ status: 'unavailable', database: 'down' });
  }
  res.json({ status: 'ok', database: 'up' });
});
