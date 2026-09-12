import { getCapability } from './capabilities.js';

export const INTRUSIVENESS_LEVELS = ['PASSIVE', 'SAFE_ACTIVE', 'AUTHENTICATED', 'RESTRICTED'];

export function intrusivenessAllows(requested, required) {
  return INTRUSIVENESS_LEVELS.indexOf(requested) >= INTRUSIVENESS_LEVELS.indexOf(required);
}

export function assertValidAdapter(adapter) {
  const required = ['id', 'name', 'license', 'intrusiveness', 'supportedTargetTypes', 'supportedAnalysisTypes', 'capabilities', 'healthCheck', 'execute'];
  const missing = required.filter((key) => adapter[key] === undefined);
  if (missing.length > 0) {
    throw new Error(`Invalid engine adapter "${adapter.id ?? '?'}": missing ${missing.join(', ')}`);
  }
  if (!INTRUSIVENESS_LEVELS.includes(adapter.intrusiveness)) {
    throw new Error(`Invalid engine adapter "${adapter.id}": bad intrusiveness "${adapter.intrusiveness}"`);
  }
  for (const key of ['capabilities', 'supportedTargetTypes', 'supportedAnalysisTypes']) {
    if (!Array.isArray(adapter[key]) || adapter[key].length === 0) {
      throw new Error(`Invalid engine adapter "${adapter.id}": ${key} must be a non-empty array`);
    }
  }
  const unknown = adapter.capabilities.filter((id) => !getCapability(id));
  if (unknown.length > 0) {
    throw new Error(`Invalid engine adapter "${adapter.id}": unknown capabilities ${unknown.join(', ')}`);
  }
  const underDeclared = adapter.capabilities.filter((id) => !intrusivenessAllows(adapter.intrusiveness, getCapability(id).requiredIntrusiveness));
  if (underDeclared.length > 0) {
    throw new Error(`Invalid engine adapter "${adapter.id}": intrusiveness is too low for ${underDeclared.join(', ')}`);
  }
  const legacy = [...adapter.supportedAnalysisTypes].sort().join(',');
  const canonical = [...adapter.capabilities].sort().join(',');
  if (legacy !== canonical) {
    throw new Error(`Invalid engine adapter "${adapter.id}": supportedAnalysisTypes must mirror canonical capabilities`);
  }
  for (const [targetType, capabilities] of Object.entries(adapter.capabilitiesByTargetType || {})) {
    if (!adapter.supportedTargetTypes.includes(targetType) || capabilities.some((id) => !adapter.capabilities.includes(id))) {
      throw new Error(`Invalid engine adapter "${adapter.id}": bad capabilitiesByTargetType entry for ${targetType}`);
    }
  }
}
