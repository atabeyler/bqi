/**
 * Optional error tracking — activates when SENTRY_DSN is set; otherwise
 * initSentry()/attachSentryErrorHandler() are silent no-ops.
 */
import * as Sentry from '@sentry/node';

export function isSentryConfigured(): boolean {
  return !!process.env.SENTRY_DSN;
}

export function initSentry(): void {
  if (!isSentryConfigured()) return;
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.1,
  });
}

/**
 * Must be called AFTER all routes are registered — adds Sentry to
 * Express's error-handling chain.
 */
export function attachSentryErrorHandler(app: import('express').Express): void {
  if (!isSentryConfigured()) return;
  Sentry.setupExpressErrorHandler(app);
}

export { Sentry };
