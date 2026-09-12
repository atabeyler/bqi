/**
 * Sentry auto-instrumentation must load BEFORE everything else — that's why
 * it's passed to node/tsx as a separate file via `--import` (see the
 * start/dev scripts in package.json). initSentry() is a no-op when
 * SENTRY_DSN is unset.
 */
import dotenv from 'dotenv';
import { initSentry } from './lib/sentry.js';

dotenv.config();
initSentry();
