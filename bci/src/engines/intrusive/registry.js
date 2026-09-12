// BCI Smart Intrusive -- Dynamic Intrusive Validation Registry.
//
// A validation MODULE is a self-contained unit registered here by simply
// being added to MODULES below (or imported from modules/*.js and pushed
// into the array) -- intrusiveValidation.js (the adapter/engine BCI's
// pipeline actually calls) never hard-codes a module list of its own, it
// only ever asks this registry "which modules are applicable to this
// target/evidence right now" and runs whatever comes back. A future
// module ships by adding one file here; the core engine, scan pipeline,
// and normalization layer never need to change.
//
// Every module declares:
//   id, family, name, description   -- identity
//   status: 'IMPLEMENTED' | 'PLANNED' -- PLANNED modules are real,
//     reviewed, intended future work, visible in the registry (and in
//     GET /api/v1/engines/intrusive-modules) for transparency -- but
//     NEVER run, never claimed as executed, never contribute a finding.
//     This is the honest alternative to silently pretending a family
//     that isn't really implemented yet ran.
//   requiredIntrusiveness           -- always 'RESTRICTED' today; kept as
//     a field (not a hard-coded constant elsewhere) so a future lower-
//     intrusiveness module is possible without a registry shape change.
//   isApplicable(context) -> boolean -- real, per-run dynamic selection:
//     target type, discovered surface (OpenAPI presence, endpoint count),
//     and prior findings decide whether THIS module has anything
//     meaningful to do against THIS target right now. Two different
//     targets legitimately run two different module sets.
//   run(context) -> Promise<ValidationRecord[]>  -- IMPLEMENTED only.
//     Performs the real network/HTTP execution itself (curl, via
//     nativeHttp.js) -- the registry/orchestrator never fabricates a
//     result on a module's behalf.
import { httpMethodProtocolModule } from './modules/httpMethodProtocol.js';
import { corsValidationModule } from './modules/corsValidation.js';
import { securityHeaderBehaviorModule } from './modules/securityHeaderBehavior.js';
import { errorDisclosureModule } from './modules/errorDisclosure.js';
import { hostRoutingValidationModule } from './modules/hostRoutingValidation.js';
import { pathNormalizationModule } from './modules/pathNormalization.js';
import { contentTypeNegotiationModule } from './modules/contentTypeNegotiation.js';
import { rateLimitHeaderObservationModule } from './modules/rateLimitHeaderObservation.js';
import { findingReproducibilityModule } from './modules/findingReproducibility.js';
import { openApiSchemaBehaviorModule } from './modules/openApiSchemaBehavior.js';
import { cacheProxyBehaviorModule } from './modules/cacheProxyBehavior.js';
import { webSocketProtocolModule } from './modules/webSocketProtocol.js';
import { technologySpecificValidationModule } from './modules/technologySpecificValidation.js';
import { PLANNED_MODULES } from './modules/planned.js';

const MODULES = [
  httpMethodProtocolModule,
  corsValidationModule,
  securityHeaderBehaviorModule,
  errorDisclosureModule,
  hostRoutingValidationModule,
  pathNormalizationModule,
  contentTypeNegotiationModule,
  rateLimitHeaderObservationModule,
  findingReproducibilityModule,
  openApiSchemaBehaviorModule,
  cacheProxyBehaviorModule,
  webSocketProtocolModule,
  technologySpecificValidationModule,
  ...PLANNED_MODULES,
];

const byId = new Map(MODULES.map((m) => [m.id, m]));
if (byId.size !== MODULES.length) {
  throw new Error('Duplicate intrusive validation module id registered');
}

export function listIntrusiveModules() {
  return MODULES;
}

export function getIntrusiveModule(id) {
  return byId.get(id) || null;
}

export function listImplementedModules() {
  return MODULES.filter((m) => m.status === 'IMPLEMENTED');
}

// Real, per-run dynamic selection (spec: "sabit birkaç testten oluşan
// liste yapıp bırakma... hedefe, teknolojiye, endpointlere ve mevcut
// bulgulara göre uygulanabilir modülleri dinamik seç"). Two targets with
// different discovered surface/evidence legitimately get two different
// module sets -- this is never a fixed list.
export function selectApplicableModules(context) {
  return listImplementedModules().filter((module) => {
    try {
      return module.isApplicable(context);
    } catch {
      return false; // a module's own applicability check failing is never fatal to the run
    }
  });
}
