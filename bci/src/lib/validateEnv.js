const REQUIRED_IN_PRODUCTION = ['BCI_DATABASE_URL', 'BCI_JWT_SECRET'];

export function validateEnv(env = process.env) {
  const errors = [];

  if (env.BCI_ENGINE_HEALTH_MODE && !['LOCAL', 'WORKER'].includes(env.BCI_ENGINE_HEALTH_MODE)) {
    errors.push('BCI_ENGINE_HEALTH_MODE must be LOCAL or WORKER');
  }

  if (env.NODE_ENV === 'production') {
    for (const key of REQUIRED_IN_PRODUCTION) {
      if (!env[key]) {
        errors.push(`${key} is required in production`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`BCI configuration invalid:\n  - ${errors.join('\n  - ')}`);
  }
}
