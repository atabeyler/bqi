import { config } from '../config.js';
import { assertValidProvider } from './AiProvider.js';
import { disabledProvider } from './providers/disabledProvider.js';
import { anthropicProvider } from './providers/anthropicProvider.js';
import { logger } from '../logger.js';

const PROVIDERS_BY_MODE = {
  EXTERNAL_AI: anthropicProvider,
  AI_DISABLED: disabledProvider,
};

export function getActiveProvider() {
  const provider = PROVIDERS_BY_MODE[config.aiMode];
  if (!provider) {
    // LOCAL_AI/PRIVATE_AI aren't implemented yet -- fail toward the safe
    // default (disabled) rather than throwing, matching spec section 62's
    // "AI unavailable -> base security analysis continues" posture.
    logger.warn({ aiMode: config.aiMode }, 'Unknown or unimplemented BCI_AI_MODE, falling back to AI_DISABLED');
    return disabledProvider;
  }
  assertValidProvider(provider);
  return provider;
}
