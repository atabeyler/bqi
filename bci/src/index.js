import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { runMigrations } from './db/migrate.js';
import { runBootstrap } from './services/bootstrap.js';
import { startSelfPing } from './services/selfPing.js';

const app = createApp();

app.listen(config.port, () => {
  logger.info({ port: config.port, env: config.nodeEnv }, 'BCI API listening');
  const ping = startSelfPing({ path: '/api/v1/health', log: logger }); // off unless ENABLE_SELF_PING=true
  if (ping) logger.info({ url: ping.url }, '[selfPing] keeping the Render instance warm');
});

runMigrations()
  .then(() => runBootstrap())
  .catch((err) => {
    logger.error({ err }, 'BCI startup migrations/bootstrap failed');
  });
