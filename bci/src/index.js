import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { runMigrations } from './db/migrate.js';
import { runBootstrap } from './services/bootstrap.js';

const app = createApp();

app.listen(config.port, () => {
  logger.info({ port: config.port, env: config.nodeEnv }, 'BCI API listening');
});

runMigrations()
  .then(() => runBootstrap())
  .catch((err) => {
    logger.error({ err }, 'BCI startup migrations/bootstrap failed');
  });
