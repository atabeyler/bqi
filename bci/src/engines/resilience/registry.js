// BCI Smart Resilience -- Dynamic Resilience Registry. Same architecture
// as the Dynamic Intrusive Validation Registry
// (bci/src/engines/intrusive/registry.js): a module is registered simply
// by being added to MODULES below, availabilityProbeAdapter (the engine
// BCI's pipeline actually calls) never hard-codes a module list, and a
// future module ships by adding one file under modules/ -- no core-engine
// change required.
//
// Every module declares:
//   id, family, name, description, status ('IMPLEMENTED' | 'PLANNED')
//   requiredIntrusiveness -- always 'RESTRICTED' today.
//   isApplicable(context) -> boolean -- real, per-run dynamic selection
//     (target, discovered endpoints, prior findings, auth availability).
//   run(context) -> Promise<RESILIENCE_ROUND[]>  -- IMPLEMENTED only; a
//     PLANNED module has neither isApplicable nor run, only a real,
//     honest blockedOn reason (never silently unwritten, never executed).
import { baselinePerformanceModule } from './modules/baselinePerformance.js';
import { concurrencyModule } from './modules/concurrency.js';
import { rampUpModule, rampDownModule } from './modules/ramp.js';
import { sustainedLoadModule } from './modules/sustainedLoad.js';
import { spikeModule, burstModule } from './modules/spikeBurst.js';
import { capacityModule, saturationDetectionModule } from './modules/capacity.js';
import { recoveryModule } from './modules/recovery.js';
import { rateLimitModule } from './modules/rateLimit.js';
import { timeoutBehaviorModule } from './modules/timeoutBehavior.js';
import { multiEndpointModule } from './modules/multiEndpoint.js';
import { authenticatedLoadModule } from './modules/authenticatedLoad.js';
import { crossEngineTargetedResilienceModule } from './modules/crossEngineTargetedResilience.js';
import { PLANNED_MODULES } from './modules/planned.js';

const MODULES = [
  baselinePerformanceModule,
  concurrencyModule,
  rampUpModule,
  rampDownModule,
  sustainedLoadModule,
  spikeModule,
  burstModule,
  capacityModule,
  saturationDetectionModule,
  recoveryModule,
  rateLimitModule,
  timeoutBehaviorModule,
  multiEndpointModule,
  authenticatedLoadModule,
  crossEngineTargetedResilienceModule,
  ...PLANNED_MODULES,
];

const byId = new Map(MODULES.map((m) => [m.id, m]));
if (byId.size !== MODULES.length) {
  throw new Error('Duplicate resilience module id registered');
}

export function listResilienceModules() {
  return MODULES;
}

export function getResilienceModule(id) {
  return byId.get(id) || null;
}

export function listImplementedResilienceModules() {
  return MODULES.filter((m) => m.status === 'IMPLEMENTED');
}

// Real, per-run dynamic selection -- two targets with different
// discovered surface/evidence legitimately get two different module
// sets (e.g. MULTI_ENDPOINT only applies when 2+ real endpoints are
// known; CROSS_ENGINE_TARGETED_RESILIENCE only when real priorFindings
// exist; AUTHENTICATED_LOAD only when a real auth header was supplied).
export function selectApplicableResilienceModules(context) {
  return listImplementedResilienceModules().filter((module) => {
    try {
      return module.isApplicable(context);
    } catch {
      return false;
    }
  });
}
