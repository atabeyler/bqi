import { query } from '../db/client.js';
import { normalizeRaw } from '../normalization/normalize.js';

export async function storeRawObservation({ orgId, jobId, engineId, target, payload }) {
  const { rows } = await query(
    `INSERT INTO raw_observations (org_id, job_id, engine_id, target, payload)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgId, jobId, engineId, target, JSON.stringify(payload)]
  );
  return rows[0].id;
}

// Reads one raw_observations row back and writes its normalized form.
// Deliberately two steps (store raw, then normalize) rather than one: a
// normalizer bug or a schema change must never mean the engine's raw output
// is lost, only that it hasn't been turned into normalized observations yet
// (spec section 15's Observation != Finding split, one level earlier).
export async function normalizeStoredObservation(rawObservationId) {
  const { rows } = await query(
    `SELECT ro.*, sj.target_type FROM raw_observations ro
       LEFT JOIN scan_jobs sj ON sj.id = ro.job_id WHERE ro.id = $1`,
    [rawObservationId]
  );
  const raw = rows[0];
  if (!raw) throw new Error(`raw_observations row not found: ${rawObservationId}`);

  const { rows: engineRows } = await query('SELECT version FROM engine_health WHERE engine_id = $1', [raw.engine_id]);
  const engineVersion = engineRows[0]?.version ?? null;

  const normalized = normalizeRaw(raw.engine_id, raw.payload);

  const inserted = [];
  for (const obs of normalized) {
    const { rows: insertedRows } = await query(
      `INSERT INTO normalized_observations (
         org_id, raw_observation_id, job_id, engine_id, engine_version, rule_id, target,
         category, title, description, engine_severity, cve_ids, cwe_ids, cvss_vector,
         cvss_score, component, component_version, location, evidence, "references", capability_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING id`,
      [
        raw.org_id,
        raw.id,
        raw.job_id,
        raw.engine_id,
        engineVersion,
        obs.ruleId ?? null,
        obs.target ?? raw.target,
        obs.category,
        obs.title,
        obs.description ?? null,
        obs.engineSeverity ?? null,
        obs.cveIds ?? [],
        obs.cweIds ?? [],
        obs.cvssVector ?? null,
        obs.cvssScore ?? null,
        obs.component ?? null,
        obs.componentVersion ?? null,
        obs.location ?? null,
        JSON.stringify(obs.evidence ?? {}),
        obs.references ?? [],
        raw.target_type === 'API' && raw.engine_id === 'nuclei' ? 'API' : (obs.capabilityId ?? null),
      ]
    );
    inserted.push(insertedRows[0].id);
  }
  return inserted;
}
