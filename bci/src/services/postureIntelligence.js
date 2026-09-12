import { createHash } from 'node:crypto';
import { query } from '../db/client.js';
import { redactSnapshotValue } from '../engines/adapters/postureIntelligence.js';

function evidenceKey(snapshotHash, finding, index) {
  return createHash('sha256')
    .update(`${snapshotHash}:${finding.ruleId}:${finding.location}:${index}`)
    .digest('hex');
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function upsertEntity(orgId, entity, observedAt) {
  const { rows } = await query(
    `INSERT INTO cyber_entities (
       org_id, entity_type, external_key, label, provider, region, attributes, first_seen_at, last_seen_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
     ON CONFLICT (org_id, entity_type, external_key) DO UPDATE SET
       label = EXCLUDED.label,
       provider = COALESCE(EXCLUDED.provider, cyber_entities.provider),
       region = COALESCE(EXCLUDED.region, cyber_entities.region),
       attributes = EXCLUDED.attributes,
       last_seen_at = GREATEST(cyber_entities.last_seen_at, EXCLUDED.last_seen_at),
       updated_at = now()
     RETURNING id`,
    [orgId, entity.type, entity.key, entity.label || entity.key, entity.provider || null, entity.region || null, JSON.stringify(redactSnapshotValue(entity.attributes)), observedAt]
  );
  return rows[0].id;
}

export async function ingestPostureEnvelope({ orgId, jobId, target, targetType, envelope }) {
  if (!envelope?.payloadHash || !Array.isArray(envelope.entities)) return null;
  const observedAt = new Date(envelope.collectedAt);

  const { rows: snapshotRows } = await query(
    `INSERT INTO posture_snapshots (
       org_id, scan_job_id, source, schema_version, target, target_type, collected_at,
       payload_hash, entity_count, relationship_count, finding_count
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (org_id, payload_hash) DO UPDATE SET scan_job_id = COALESCE(posture_snapshots.scan_job_id, EXCLUDED.scan_job_id)
     RETURNING id`,
    [orgId, jobId, envelope.source, envelope.schemaVersion, target, targetType, observedAt, envelope.payloadHash, envelope.entities.length, envelope.relationships.length, envelope.findings.length]
  );
  const snapshotId = snapshotRows[0].id;

  const entityIds = new Map();
  for (const entity of envelope.entities) {
    const id = await upsertEntity(orgId, entity, observedAt);
    entityIds.set(`${entity.type}:${entity.key}`, id);
    const attributes = redactSnapshotValue(entity.attributes);
    await query(
      `INSERT INTO snapshot_entity_states (snapshot_id, entity_type, external_key, label, attributes, fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [snapshotId, entity.type, entity.key, entity.label || entity.key, JSON.stringify(attributes), fingerprint(attributes)]
    );
  }

  for (const relationship of envelope.relationships) {
    const sourceId = entityIds.get(`${relationship.sourceType}:${relationship.sourceKey}`);
    const targetId = entityIds.get(`${relationship.targetType}:${relationship.targetKey}`);
    if (!sourceId || !targetId || sourceId === targetId) continue;
    const relationshipEvidence = redactSnapshotValue(relationship.evidence);
    await query(
      `INSERT INTO cyber_relationships (
         org_id, source_entity_id, target_entity_id, relationship_type, evidence, confidence, first_seen_at, last_seen_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
       ON CONFLICT (org_id, source_entity_id, target_entity_id, relationship_type) DO UPDATE SET
         evidence = EXCLUDED.evidence,
         confidence = EXCLUDED.confidence,
         last_seen_at = GREATEST(cyber_relationships.last_seen_at, EXCLUDED.last_seen_at)`,
      [orgId, sourceId, targetId, relationship.type, JSON.stringify(relationshipEvidence), relationship.confidence, observedAt]
    );
    await query(
      `INSERT INTO snapshot_relationship_states (
         snapshot_id, source_type, source_key, target_type, target_key, relationship_type, evidence, fingerprint
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [snapshotId, relationship.sourceType, relationship.sourceKey, relationship.targetType, relationship.targetKey, relationship.type, JSON.stringify(relationshipEvidence), fingerprint(relationshipEvidence)]
    );
  }

  for (const control of envelope.controls) {
    const controlEvidence = redactSnapshotValue({ ...control.evidence, protects: control.protects });
    const { rows: controlRows } = await query(
      `INSERT INTO security_controls (org_id, external_key, control_type, label, status, effectiveness, evidence, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (org_id, external_key) DO UPDATE SET
         control_type = EXCLUDED.control_type, label = EXCLUDED.label, status = EXCLUDED.status,
         effectiveness = EXCLUDED.effectiveness, evidence = EXCLUDED.evidence,
         observed_at = GREATEST(security_controls.observed_at, EXCLUDED.observed_at), updated_at = now()
       RETURNING id`,
      [orgId, control.key, control.type, control.label || control.key, control.status, control.effectiveness, JSON.stringify(controlEvidence), observedAt]
    );
    await query(
      `INSERT INTO snapshot_control_states (
         snapshot_id, external_key, control_type, status, effectiveness, evidence, fingerprint
       ) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [snapshotId, control.key, control.type, control.status, control.effectiveness, JSON.stringify(controlEvidence), fingerprint({ status: control.status, effectiveness: control.effectiveness, evidence: controlEvidence })]
    );
    for (const protectedEntity of control.protects) {
      const entityId = entityIds.get(`${protectedEntity.entityType.toUpperCase()}:${protectedEntity.entityKey}`);
      if (!entityId) continue;
      await query(
        `INSERT INTO control_entity_links (org_id, control_id, entity_id) VALUES ($1,$2,$3)
         ON CONFLICT DO NOTHING`,
        [orgId, controlRows[0].id, entityId]
      );
    }
  }

  for (const [index, finding] of envelope.findings.entries()) {
    await query(
      `INSERT INTO decision_evidence (
         org_id, snapshot_id, evidence_key, source, engine_id, target, evidence_type,
         summary, redacted_payload, confidence, verification_status, observed_at
       ) VALUES ($1,$2,$3,$4,'bci-posture-intelligence',$5,$6,$7,$8,80,'OBSERVED',$9)
       ON CONFLICT (org_id, evidence_key) DO UPDATE SET
         snapshot_id = EXCLUDED.snapshot_id, redacted_payload = EXCLUDED.redacted_payload,
         observed_at = GREATEST(decision_evidence.observed_at, EXCLUDED.observed_at)`,
      [orgId, snapshotId, evidenceKey(envelope.payloadHash, finding, index), envelope.source, finding.target || target, finding.capabilityId, finding.title, JSON.stringify(redactSnapshotValue(finding.evidence)), observedAt]
    );
  }

  return { snapshotId, entities: entityIds.size, relationships: envelope.relationships.length, findings: envelope.findings.length };
}
