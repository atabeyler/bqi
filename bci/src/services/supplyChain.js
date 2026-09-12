import { query } from '../db/client.js';
import { exportCycloneDx, exportSpdx } from '../intelligence/sbom.js';

export async function exportOrganizationSbom(orgId, format) {
  const { rows: entities } = await query(
    `SELECT entity_type, external_key, label, attributes FROM cyber_entities
      WHERE org_id = $1 AND entity_type IN (
        'PACKAGE', 'ARTIFACT', 'CONTAINER', 'MODEL', 'DATASET', 'AI_FRAMEWORK',
        'MODEL_PROVIDER', 'AI_APPLICATION', 'AI_AGENT'
      )`,
    [orgId]
  );
  const { rows: relationships } = await query(
    `SELECT source.external_key AS source_key, target.external_key AS target_key, cr.relationship_type
       FROM cyber_relationships cr
       JOIN cyber_entities source ON source.id = cr.source_entity_id
       JOIN cyber_entities target ON target.id = cr.target_entity_id
      WHERE cr.org_id = $1 AND cr.relationship_type IN (
        'DEPENDS_ON', 'TRAINED_ON', 'BUILT_WITH', 'PACKAGED_AS', 'RUNS_IN',
        'POWERS', 'OPERATES', 'PROVIDED_BY'
      )`,
    [orgId]
  );
  return format === 'SPDX' ? exportSpdx(entities, relationships) : exportCycloneDx(entities, relationships);
}
