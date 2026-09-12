const REQUIRED_METHODS = ['capability', 'activate', 'expire'];

export function assertPublicVisibilityProvider(provider) {
  if (!provider || typeof provider.id !== 'string' || !/^[a-z0-9][a-z0-9-]+$/.test(provider.id)) {
    throw new TypeError('invalid_public_visibility_provider_id');
  }
  if (typeof provider.infrastructureProvider !== 'string') {
    throw new TypeError(`invalid_public_visibility_provider_infrastructure:${provider.id}`);
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof provider[method] !== 'function') throw new TypeError(`invalid_public_visibility_provider_method:${provider.id}:${method}`);
  }
  return provider;
}

export function assertActivationResult(provider, activation) {
  if (!activation || activation.providerId !== provider.id
    || !(activation.startedAt instanceof Date) || !(activation.expiresAt instanceof Date)
    || !Array.isArray(activation.observations) || activation.observations.length < 2
    || !activation.observations.every((observation) => observation?.visible === true)) {
    throw new Error('invalid_public_visibility_activation_result');
  }
  return activation;
}
