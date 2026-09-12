import { cloudflareEdgePublicVisibility } from './cloudflareEdge.js';
import { config } from '../../config.js';
import { assertActivationResult, assertPublicVisibilityProvider } from './providerContract.js';

const PROVIDERS = [cloudflareEdgePublicVisibility].map(assertPublicVisibilityProvider);

function orderedProviders() {
  const order = config.controlledProof.publicProviderOrder;
  if (!order.length) return PROVIDERS;
  return [...PROVIDERS].sort((left, right) => {
    const leftIndex = order.indexOf(left.id);
    const rightIndex = order.indexOf(right.id);
    return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
  });
}

function discoveredInfrastructure(discovery) {
  return new Set((discovery?.candidates || []).filter((candidate) => candidate.score >= 40).map((candidate) => candidate.providerId));
}

export function resolvePublicVisibilityProvider(target, discovery = null) {
  const detected = discoveredInfrastructure(discovery);
  return orderedProviders().find((provider) => {
    const capability = provider.capability(target);
    return capability.available && (detected.size === 0 || detected.has(provider.infrastructureProvider));
  }) || null;
}

export function publicVisibilityCapabilities(target) {
  return orderedProviders().map((provider) => provider.capability(target));
}

export function getPublicVisibilityProvider(id) {
  return PROVIDERS.find((provider) => provider.id === id) || null;
}

export async function activatePublicVisibilityProvider(id, input) {
  const provider = getPublicVisibilityProvider(id);
  if (!provider || !provider.capability(input.target).available) throw new Error('public_visibility_provider_unavailable');
  return assertActivationResult(provider, await provider.activate(input));
}

export async function expirePublicVisibilityProvider(id, input) {
  const provider = getPublicVisibilityProvider(id);
  if (!provider) return { removed: false, reason: 'provider_unavailable_during_expiry' };
  const result = await provider.expire(input);
  return result?.removed === true ? result : { ...result, removed: false };
}
