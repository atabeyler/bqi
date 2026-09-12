import { query } from '../db/client.js';

function entityId(entity) {
  return `${entity.entity_type || entity.entityType}:${entity.external_key || entity.externalKey}`;
}

function relationshipId(relationship) {
  return [
    relationship.source_type || relationship.sourceType,
    relationship.source_key || relationship.sourceKey,
    relationship.relationship_type || relationship.relationshipType,
    relationship.target_type || relationship.targetType,
    relationship.target_key || relationship.targetKey,
  ].join(':');
}

function controlId(control) {
  return control.external_key || control.externalKey;
}

function publicExposure(attributes = {}) {
  return attributes.public === true || attributes.internetExposed === true || attributes.public === 'PUBLIC';
}

function privilege(attributes = {}) {
  const permissions = Array.isArray(attributes.permissions) ? attributes.permissions : [];
  return attributes.excessivePrivilege === true || attributes.clusterAdmin === true || permissions.includes('*') || permissions.includes('*:*');
}

function vulnerabilities(attributes = {}) {
  return new Set(Array.isArray(attributes.vulnerabilities) ? attributes.vulnerabilities : []);
}

export function comparePostureStates(before, after) {
  const beforeEntities = new Map((before.entities || []).map((item) => [entityId(item), item]));
  const afterEntities = new Map((after.entities || []).map((item) => [entityId(item), item]));
  const beforeRelationships = new Map((before.relationships || []).map((item) => [relationshipId(item), item]));
  const afterRelationships = new Map((after.relationships || []).map((item) => [relationshipId(item), item]));
  const beforeControls = new Map((before.controls || []).map((item) => [controlId(item), item]));
  const afterControls = new Map((after.controls || []).map((item) => [controlId(item), item]));

  const addedEntities = [...afterEntities.keys()].filter((key) => !beforeEntities.has(key));
  const removedEntities = [...beforeEntities.keys()].filter((key) => !afterEntities.has(key));
  const changedEntities = [...afterEntities.entries()]
    .filter(([key, item]) => beforeEntities.has(key) && beforeEntities.get(key).fingerprint !== item.fingerprint)
    .map(([key]) => key);
  const addedRelationships = [...afterRelationships.keys()].filter((key) => !beforeRelationships.has(key));
  const removedRelationships = [...beforeRelationships.keys()].filter((key) => !afterRelationships.has(key));
  const removedControls = [...beforeControls.keys()].filter((key) => !afterControls.has(key));
  const degradedControls = [...afterControls.entries()]
    .filter(([key, control]) => {
      const previous = beforeControls.get(key);
      return previous && (Number(control.effectiveness) < Number(previous.effectiveness) || ['INEFFECTIVE', 'UNKNOWN'].includes(control.status) && !['INEFFECTIVE', 'UNKNOWN'].includes(previous.status));
    })
    .map(([key]) => key);

  const newExposures = [...afterEntities.entries()]
    .filter(([key, item]) => publicExposure(item.attributes) && !publicExposure(beforeEntities.get(key)?.attributes))
    .map(([key]) => key);
  const newPrivileges = [...afterEntities.entries()]
    .filter(([key, item]) => privilege(item.attributes) && !privilege(beforeEntities.get(key)?.attributes))
    .map(([key]) => key);
  const newVulnerabilities = [];
  for (const [key, entity] of afterEntities) {
    const previous = vulnerabilities(beforeEntities.get(key)?.attributes);
    for (const cveId of vulnerabilities(entity.attributes)) {
      if (!previous.has(cveId)) newVulnerabilities.push({ entity: key, cveId });
    }
  }
  const reopenedAttackPaths = addedRelationships.filter((key) => /:(EXPOSES|CONNECTS_TO|CAN_ACCESS|TRUSTS|ROUTES_TO):/.test(`:${key}:`));
  const regressionCount = newExposures.length + newPrivileges.length + newVulnerabilities.length + removedControls.length + degradedControls.length + reopenedAttackPaths.length;

  return {
    baselineSnapshotId: before.id || null,
    currentSnapshotId: after.id || null,
    addedEntities,
    removedEntities,
    changedEntities,
    addedRelationships,
    removedRelationships,
    newExposures,
    newPrivileges,
    newVulnerabilities,
    removedControls,
    degradedControls,
    reopenedAttackPaths,
    securityRegression: regressionCount > 0,
    regressionCount,
  };
}

async function loadSnapshot(orgId, snapshotId) {
  const { rows: snapshots } = await query(
    'SELECT id, target, target_type, source, collected_at FROM posture_snapshots WHERE id = $1 AND org_id = $2',
    [snapshotId, orgId]
  );
  if (!snapshots[0]) return null;
  const [{ rows: entities }, { rows: relationships }, { rows: controls }] = await Promise.all([
    query('SELECT entity_type, external_key, label, attributes, fingerprint FROM snapshot_entity_states WHERE snapshot_id = $1', [snapshotId]),
    query('SELECT source_type, source_key, target_type, target_key, relationship_type, evidence, fingerprint FROM snapshot_relationship_states WHERE snapshot_id = $1', [snapshotId]),
    query('SELECT external_key, control_type, status, effectiveness, evidence, fingerprint FROM snapshot_control_states WHERE snapshot_id = $1', [snapshotId]),
  ]);
  return { ...snapshots[0], entities, relationships, controls };
}

export async function comparePostureSnapshots(orgId, beforeSnapshotId, afterSnapshotId) {
  const [before, after] = await Promise.all([loadSnapshot(orgId, beforeSnapshotId), loadSnapshot(orgId, afterSnapshotId)]);
  if (!before || !after) return null;
  if (before.target !== after.target || before.target_type !== after.target_type) {
    throw new Error('posture snapshots must describe the same target and target type');
  }
  return comparePostureStates(before, after);
}
