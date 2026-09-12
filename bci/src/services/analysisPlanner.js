import { listAdapters } from '../engines/registry.js';
import { getCapability, listCapabilities } from '../engines/capabilities.js';
import { intrusivenessAllows } from '../engines/EngineAdapter.js';

function normalizeCapabilities(requestedCapabilities) {
  if (!requestedCapabilities) return [];
  return (Array.isArray(requestedCapabilities) ? requestedCapabilities : [requestedCapabilities])
    .map((id) => String(id).toUpperCase());
}

function executionMode(adapter, targetType) {
  if (targetType === 'CONTAINER') return 'image';
  if (targetType === 'REPOSITORY') return 'fs';
  if (targetType === 'IP' || targetType === 'CIDR') return 'host';
  return 'url';
}

function capabilitiesForTarget(adapter, targetType) {
  return adapter.capabilitiesByTargetType?.[targetType] ?? adapter.capabilities;
}

export function planEngines(targetType, requestedClass, requestedCapabilities = null) {
  const selected = normalizeCapabilities(requestedCapabilities);
  if (selected.some((id) => !getCapability(id))) return [];
  return listAdapters()
    .filter((adapter) => adapter.supportedTargetTypes.includes(targetType))
    .filter((adapter) => intrusivenessAllows(requestedClass, adapter.intrusiveness))
    .filter((adapter) => selected.length === 0 || capabilitiesForTarget(adapter, targetType).some((id) => selected.includes(id)))
    .map((adapter) => ({
      engineId: adapter.id,
      intrusiveness: adapter.intrusiveness,
      mode: executionMode(adapter, targetType),
      capabilities: selected.length === 0 ? capabilitiesForTarget(adapter, targetType) : capabilitiesForTarget(adapter, targetType).filter((id) => selected.includes(id)),
    }));
}

export function candidateEnginesForTargetType(targetType) {
  return listAdapters()
    .filter((adapter) => adapter.supportedTargetTypes.includes(targetType))
    .map((adapter) => ({ engineId: adapter.id, intrusiveness: adapter.intrusiveness, mode: executionMode(adapter, targetType), capabilities: capabilitiesForTarget(adapter, targetType) }));
}

export function availableCapabilitiesForTargetType(targetType, requestedClass = 'RESTRICTED', engineCatalog = null) {
  const candidates = candidateEnginesForTargetType(targetType);
  return listCapabilities().map((capability) => {
    const supporting = candidates.filter((candidate) => candidate.capabilities.includes(capability.id));
    const compatible = supporting.filter((candidate) => intrusivenessAllows(requestedClass, candidate.intrusiveness));
    const executable = engineCatalog
      ? compatible.filter((candidate) => engineCatalog.find((engine) => engine.id === candidate.engineId)?.status === 'HEALTHY')
      : compatible;
    return {
      ...capability,
      supported: supporting.length > 0,
      available: executable.length > 0,
      engineIds: supporting.map((candidate) => candidate.engineId),
      executableEngineIds: executable.map((candidate) => candidate.engineId),
    };
  });
}
