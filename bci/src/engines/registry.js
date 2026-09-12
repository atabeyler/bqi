import { query } from '../db/client.js';
import { config } from '../config.js';
import { assertValidAdapter } from './EngineAdapter.js';
import { listCapabilities } from './capabilities.js';
import { trivyAdapter } from './adapters/trivy.js';
import { osvScannerAdapter } from './adapters/osvScanner.js';
import { semgrepAdapter } from './adapters/semgrep.js';
import { nucleiAdapter } from './adapters/nuclei.js';
import { naabuAdapter } from './adapters/naabu.js';
import { httpFuzzAdapter } from './adapters/httpFuzz.js';
import { intrusiveValidationAdapter } from './adapters/intrusiveValidation.js';
import { availabilityProbeAdapter } from './adapters/availabilityProbe.js';
import { postureIntelligenceAdapter } from './adapters/postureIntelligence.js';

const adapters = new Map();
export function registerAdapter(adapter) {
  assertValidAdapter(adapter);
  adapters.set(adapter.id, adapter);
  return adapter;
}
export function unregisterAdapter(id) { return adapters.delete(id); }
[trivyAdapter, osvScannerAdapter, semgrepAdapter, nucleiAdapter, naabuAdapter, httpFuzzAdapter, intrusiveValidationAdapter, availabilityProbeAdapter, postureIntelligenceAdapter].forEach(registerAdapter);
export function getAdapter(id) { return adapters.get(id) || null; }
export function listAdapters() { return [...adapters.values()]; }
export function getCapabilityCatalog() { return listCapabilities(); }

function effectiveHealth(health) {
  if (!health) {
    return { status: 'UNKNOWN', version: null, detail: 'health check has not run', last_checked_at: null };
  }
  const checkedAt = new Date(health.last_checked_at).getTime();
  if (!Number.isFinite(checkedAt) || Date.now() - checkedAt > config.engineHealthStaleMs) {
    return {
      ...health,
      status: 'UNKNOWN',
      stored_status: health.status,
      detail: `health check is stale (last checked ${health.last_checked_at})`,
    };
  }
  return health;
}

export async function runHealthChecks() {
  const results = [];
  for (const adapter of adapters.values()) {
    await query(`INSERT INTO engine_registry (id, name, intrusiveness, supported_target_types, supported_analysis_types, license, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now()) ON CONFLICT (id) DO UPDATE SET name=$2, intrusiveness=$3, supported_target_types=$4, supported_analysis_types=$5, license=$6, updated_at=now()`,
      [adapter.id, adapter.name, adapter.intrusiveness, adapter.supportedTargetTypes, adapter.supportedAnalysisTypes, adapter.license]);
    const health = await adapter.healthCheck();
    await query(`INSERT INTO engine_health (engine_id, status, version, detail, last_checked_at) VALUES ($1,$2,$3,$4,now()) ON CONFLICT (engine_id) DO UPDATE SET status=$2, version=$3, detail=$4, last_checked_at=now()`, [adapter.id, health.status, health.version ?? null, health.detail ?? null]);
    results.push({ id: adapter.id, ...health });
  }
  return results;
}
export async function getEngineStatus() {
  const { rows } = await query(`SELECT r.id, r.name, r.intrusiveness, r.supported_target_types, r.supported_analysis_types, r.license, h.status, h.version, h.detail, h.last_checked_at FROM engine_registry r LEFT JOIN engine_health h ON h.engine_id=r.id ORDER BY r.id`);
  return rows.map((row) => ({
    ...row,
    ...effectiveHealth(row.status ? row : null),
    capabilities: getAdapter(row.id)?.capabilities ?? [],
    executionOptions: getAdapter(row.id)?.executionOptions ?? null,
  }));
}
export async function getEngineCatalog() {
  const { rows: health } = await query('SELECT engine_id, status, version, detail, last_checked_at FROM engine_health');
  const healthById = new Map(health.map((h) => [h.engine_id, h]));
  return [...adapters.values()].map((a) => {
    const h = effectiveHealth(healthById.get(a.id));
    return {
      id: a.id,
      name: a.name,
      intrusiveness: a.intrusiveness,
      capabilities: a.capabilities,
      supportedTargetTypes: a.supportedTargetTypes,
      supportedAnalysisTypes: a.supportedAnalysisTypes,
      license: a.license,
      executionOptions: a.executionOptions ?? null,
      status: h.status,
      storedStatus: h.stored_status ?? h.status,
      version: h.version ?? null,
      detail: h.detail ?? null,
      lastCheckedAt: h.last_checked_at ?? null,
    };
  });
}
