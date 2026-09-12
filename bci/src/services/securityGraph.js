import { query } from '../db/client.js';

// The graph is a projection, not a second source of truth: this rebuilds it
// from assets/asset_relationships/findings/vulnerabilities every time it's
// called. Idempotent via ON CONFLICT upserts -- safe to call repeatedly
// (e.g. after every correlation run) without accumulating duplicate nodes
// or edges.
export async function syncSecurityGraph(orgId) {
  const { rows: assets } = await query('SELECT id, name, asset_type, criticality FROM assets WHERE org_id = $1', [orgId]);
  const assetNodeIds = new Map();

  for (const asset of assets) {
    const { rows } = await query(
      `INSERT INTO security_graph_nodes (org_id, node_type, ref_id, label, metadata)
       VALUES ($1, 'ASSET', $2, $3, $4)
       ON CONFLICT (org_id, node_type, ref_id) DO UPDATE SET label = $3, metadata = $4
       RETURNING id`,
      [orgId, asset.id, asset.name, JSON.stringify({ assetType: asset.asset_type, criticality: asset.criticality })]
    );
    assetNodeIds.set(asset.id, rows[0].id);
  }

  const { rows: relationships } = await query(
    'SELECT source_asset_id, target_asset_id, relationship_type FROM asset_relationships WHERE org_id = $1',
    [orgId]
  );
  for (const rel of relationships) {
    const sourceNodeId = assetNodeIds.get(rel.source_asset_id);
    const targetNodeId = assetNodeIds.get(rel.target_asset_id);
    if (!sourceNodeId || !targetNodeId) continue;
    await query(
      `INSERT INTO security_graph_edges (org_id, source_node_id, target_node_id, edge_type)
       VALUES ($1, $2, $3, $4) ON CONFLICT (org_id, source_node_id, target_node_id, edge_type) DO NOTHING`,
      [orgId, sourceNodeId, targetNodeId, rel.relationship_type]
    );
  }

  // Asset -[AFFECTED_BY]-> Vulnerability, derived from open findings whose
  // target matches one of the asset's own identifiers.
  const { rows: findings } = await query(
    `SELECT f.target, unnest(f.cve_ids) AS cve_id, f.risk_score
       FROM findings f
      WHERE f.org_id = $1 AND array_length(f.cve_ids, 1) > 0
        AND f.status NOT IN ('FALSE_POSITIVE', 'VERIFIED_FIXED')`,
    [orgId]
  );
  const vulnNodeIds = new Map();

  for (const finding of findings) {
    const { rows: matchedAssets } = await query(
      `SELECT a.id FROM assets a JOIN asset_identifiers ai ON ai.asset_id = a.id
        WHERE a.org_id = $1 AND ai.value = $2`,
      [orgId, finding.target]
    );
    if (matchedAssets.length === 0) continue;

    if (!vulnNodeIds.has(finding.cve_id)) {
      const { rows } = await query(
        `INSERT INTO security_graph_nodes (org_id, node_type, ref_id, label, metadata)
         VALUES ($1, 'VULNERABILITY', $2, $2, '{}')
         ON CONFLICT (org_id, node_type, ref_id) DO UPDATE SET label = $2
         RETURNING id`,
        [orgId, finding.cve_id]
      );
      vulnNodeIds.set(finding.cve_id, rows[0].id);
    }
    const vulnNodeId = vulnNodeIds.get(finding.cve_id);

    for (const assetRow of matchedAssets) {
      const assetNodeId = assetNodeIds.get(assetRow.id);
      if (!assetNodeId) continue;
      await query(
        `INSERT INTO security_graph_edges (org_id, source_node_id, target_node_id, edge_type, metadata)
         VALUES ($1, $2, $3, 'AFFECTED_BY', $4)
         ON CONFLICT (org_id, source_node_id, target_node_id, edge_type) DO UPDATE SET metadata = $4`,
        [orgId, assetNodeId, vulnNodeId, JSON.stringify({ riskScore: finding.risk_score })]
      );
    }
  }

  // Decision Graph V2 projects evidence-backed posture entities alongside
  // the original asset graph. The relational tables remain the source of
  // truth and stable entity UUIDs keep repeated syncs idempotent.
  const { rows: cyberEntities } = await query(
    'SELECT id, entity_type, external_key, label, provider, region, attributes FROM cyber_entities WHERE org_id = $1',
    [orgId]
  );
  const cyberNodeIds = new Map();
  for (const entity of cyberEntities) {
    const { rows } = await query(
      `INSERT INTO security_graph_nodes (org_id, node_type, ref_id, label, metadata)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (org_id, node_type, ref_id) DO UPDATE SET label = EXCLUDED.label, metadata = EXCLUDED.metadata
       RETURNING id`,
      [orgId, entity.entity_type, entity.id, entity.label, JSON.stringify({ externalKey: entity.external_key, provider: entity.provider, region: entity.region, ...entity.attributes })]
    );
    cyberNodeIds.set(entity.id, rows[0].id);
  }

  const { rows: cyberRelationships } = await query(
    'SELECT source_entity_id, target_entity_id, relationship_type, evidence, confidence FROM cyber_relationships WHERE org_id = $1',
    [orgId]
  );
  for (const relationship of cyberRelationships) {
    const sourceNodeId = cyberNodeIds.get(relationship.source_entity_id);
    const targetNodeId = cyberNodeIds.get(relationship.target_entity_id);
    if (!sourceNodeId || !targetNodeId) continue;
    await query(
      `INSERT INTO security_graph_edges (org_id, source_node_id, target_node_id, edge_type, metadata)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (org_id, source_node_id, target_node_id, edge_type) DO UPDATE SET metadata = EXCLUDED.metadata`,
      [orgId, sourceNodeId, targetNodeId, relationship.relationship_type, JSON.stringify({ evidence: relationship.evidence, confidence: relationship.confidence })]
    );
  }

  // Join legacy inventory to the richer entity vocabulary only when an
  // exact identifier exists. This avoids fuzzy/guessed graph edges.
  const { rows: inventoryLinks } = await query(
    `SELECT DISTINCT a.id AS asset_id, ce.id AS entity_id
       FROM assets a
       JOIN asset_identifiers ai ON ai.asset_id = a.id
       JOIN cyber_entities ce ON ce.org_id = a.org_id AND ce.external_key = ai.value
      WHERE a.org_id = $1`,
    [orgId]
  );
  for (const link of inventoryLinks) {
    const sourceNodeId = assetNodeIds.get(link.asset_id);
    const targetNodeId = cyberNodeIds.get(link.entity_id);
    if (!sourceNodeId || !targetNodeId) continue;
    await query(
      `INSERT INTO security_graph_edges (org_id, source_node_id, target_node_id, edge_type)
       VALUES ($1,$2,$3,'REPRESENTS') ON CONFLICT DO NOTHING`,
      [orgId, sourceNodeId, targetNodeId]
    );
  }

  const { rows: controlRows } = await query(
    'SELECT id, external_key, control_type, label, status, effectiveness, evidence FROM security_controls WHERE org_id = $1',
    [orgId]
  );
  const controlNodeIds = new Map();
  for (const control of controlRows) {
    const { rows } = await query(
      `INSERT INTO security_graph_nodes (org_id, node_type, ref_id, label, metadata)
       VALUES ($1,'CONTROL',$2,$3,$4)
       ON CONFLICT (org_id, node_type, ref_id) DO UPDATE SET label = EXCLUDED.label, metadata = EXCLUDED.metadata
       RETURNING id`,
      [orgId, control.id, control.label, JSON.stringify({ externalKey: control.external_key, controlType: control.control_type, status: control.status, effectiveness: Number(control.effectiveness), evidence: control.evidence })]
    );
    controlNodeIds.set(control.id, rows[0].id);
  }
  const { rows: controlLinks } = await query(
    'SELECT control_id, entity_id FROM control_entity_links WHERE org_id = $1',
    [orgId]
  );
  for (const link of controlLinks) {
    const sourceNodeId = controlNodeIds.get(link.control_id);
    const targetNodeId = cyberNodeIds.get(link.entity_id);
    if (!sourceNodeId || !targetNodeId) continue;
    await query(
      `INSERT INTO security_graph_edges (org_id, source_node_id, target_node_id, edge_type)
       VALUES ($1,$2,$3,'PROTECTS') ON CONFLICT DO NOTHING`,
      [orgId, sourceNodeId, targetNodeId]
    );
  }

  const { rows: decisionFindings } = await query(
    `SELECT id, target, category, title, cve_ids, risk_score, confidence_score, verification_status
       FROM findings WHERE org_id = $1 AND status NOT IN ('FALSE_POSITIVE', 'VERIFIED_FIXED')`,
    [orgId]
  );
  const findingNodeIds = new Map();
  for (const finding of decisionFindings) {
    const { rows } = await query(
      `INSERT INTO security_graph_nodes (org_id, node_type, ref_id, label, metadata)
       VALUES ($1,'FINDING',$2,$3,$4)
       ON CONFLICT (org_id, node_type, ref_id) DO UPDATE SET label = EXCLUDED.label, metadata = EXCLUDED.metadata
       RETURNING id`,
      [orgId, finding.id, finding.title, JSON.stringify({ category: finding.category, riskScore: finding.risk_score, confidence: finding.confidence_score, verificationStatus: finding.verification_status })]
    );
    findingNodeIds.set(finding.id, rows[0].id);

    const matchedEntities = cyberEntities.filter((entity) => entity.external_key === finding.target || entity.label === finding.target);
    for (const entity of matchedEntities) {
      await query(
        `INSERT INTO security_graph_edges (org_id, source_node_id, target_node_id, edge_type)
         VALUES ($1,$2,$3,'HAS_FINDING') ON CONFLICT DO NOTHING`,
        [orgId, cyberNodeIds.get(entity.id), rows[0].id]
      );
    }
    for (const cveId of finding.cve_ids || []) {
      let vulnerabilityNodeId = vulnNodeIds.get(cveId);
      if (!vulnerabilityNodeId) {
        const { rows: vulnerabilityRows } = await query(
          `INSERT INTO security_graph_nodes (org_id, node_type, ref_id, label, metadata)
           VALUES ($1,'VULNERABILITY',$2,$2,'{}')
           ON CONFLICT (org_id, node_type, ref_id) DO UPDATE SET label = EXCLUDED.label RETURNING id`,
          [orgId, cveId]
        );
        vulnerabilityNodeId = vulnerabilityRows[0].id;
        vulnNodeIds.set(cveId, vulnerabilityNodeId);
      }
      await query(
        `INSERT INTO security_graph_edges (org_id, source_node_id, target_node_id, edge_type)
         VALUES ($1,$2,$3,'REFERS_TO') ON CONFLICT DO NOTHING`,
        [orgId, rows[0].id, vulnerabilityNodeId]
      );
    }
  }

  const { rows: evidenceRows } = await query(
    'SELECT id, target, evidence_type, summary, source, confidence, verification_status, observed_at FROM decision_evidence WHERE org_id = $1',
    [orgId]
  );
  for (const evidence of evidenceRows) {
    const { rows } = await query(
      `INSERT INTO security_graph_nodes (org_id, node_type, ref_id, label, metadata)
       VALUES ($1,'EVIDENCE',$2,$3,$4)
       ON CONFLICT (org_id, node_type, ref_id) DO UPDATE SET label = EXCLUDED.label, metadata = EXCLUDED.metadata
       RETURNING id`,
      [orgId, evidence.id, evidence.summary, JSON.stringify({ source: evidence.source, confidence: evidence.confidence, verificationStatus: evidence.verification_status, observedAt: evidence.observed_at })]
    );
    for (const finding of decisionFindings.filter((candidate) => candidate.target === evidence.target && candidate.category === evidence.evidence_type)) {
      await query(
        `INSERT INTO security_graph_edges (org_id, source_node_id, target_node_id, edge_type)
         VALUES ($1,$2,$3,'SUPPORTS') ON CONFLICT DO NOTHING`,
        [orgId, rows[0].id, findingNodeIds.get(finding.id)]
      );
    }
  }

  const { rows: techniqueRows } = await query(
    `SELECT atm.finding_id, atm.technique_id, atm.confidence, atm.rationale,
            atm.framework, atm.catalog_version
       FROM attack_technique_mappings atm WHERE atm.org_id = $1`,
    [orgId]
  );
  for (const mapping of techniqueRows) {
    const findingNodeId = findingNodeIds.get(mapping.finding_id);
    if (!findingNodeId) continue;
    const { rows } = await query(
      `INSERT INTO security_graph_nodes (org_id, node_type, ref_id, label, metadata)
       VALUES ($1,$2,$3,$3,$4)
       ON CONFLICT (org_id, node_type, ref_id) DO UPDATE SET label = EXCLUDED.label RETURNING id`,
      [orgId, mapping.framework === 'ATLAS' ? 'ATLAS_TECHNIQUE' : 'ATTACK_TECHNIQUE', mapping.technique_id, JSON.stringify({ framework: mapping.framework, catalogVersion: mapping.catalog_version })]
    );
    await query(
      `INSERT INTO security_graph_edges (org_id, source_node_id, target_node_id, edge_type, metadata)
       VALUES ($1,$2,$3,'EXPLAINS',$4)
       ON CONFLICT (org_id, source_node_id, target_node_id, edge_type) DO UPDATE SET metadata = EXCLUDED.metadata`,
      [orgId, rows[0].id, findingNodeId, JSON.stringify({ confidence: mapping.confidence, rationale: mapping.rationale })]
    );
    await query(
      `INSERT INTO security_graph_edges (org_id, source_node_id, target_node_id, edge_type, metadata)
       VALUES ($1,$2,$3,'MAPPED_TO',$4)
       ON CONFLICT (org_id, source_node_id, target_node_id, edge_type) DO UPDATE SET metadata = EXCLUDED.metadata`,
      [orgId, findingNodeId, rows[0].id, JSON.stringify({ confidence: mapping.confidence, evidenceGated: true })]
    );
    const mappedFinding = decisionFindings.find((finding) => finding.id === mapping.finding_id);
    for (const entity of cyberEntities.filter((candidate) => mappedFinding && (candidate.external_key === mappedFinding.target || candidate.label === mappedFinding.target))) {
      await query(
        `INSERT INTO security_graph_edges (org_id, source_node_id, target_node_id, edge_type, metadata)
         VALUES ($1,$2,$3,'TARGETS',$4)
         ON CONFLICT (org_id, source_node_id, target_node_id, edge_type) DO UPDATE SET metadata = EXCLUDED.metadata`,
        [orgId, rows[0].id, cyberNodeIds.get(entity.id), JSON.stringify({ findingId: mapping.finding_id, evidenceGated: true })]
      );
    }
  }

  const { rows: remediationRows } = await query(
    `SELECT r.id, r.finding_id, r.recommendation, r.status
       FROM remediations r JOIN findings f ON f.id = r.finding_id
      WHERE r.org_id = $1 AND f.org_id = $1`,
    [orgId]
  );
  const remediationNodeIds = new Map();
  for (const remediation of remediationRows) {
    const { rows } = await query(
      `INSERT INTO security_graph_nodes (org_id, node_type, ref_id, label, metadata)
       VALUES ($1,'REMEDIATION',$2,$3,$4)
       ON CONFLICT (org_id, node_type, ref_id) DO UPDATE SET label = EXCLUDED.label, metadata = EXCLUDED.metadata
       RETURNING id`,
      [orgId, remediation.id, remediation.recommendation, JSON.stringify({ status: remediation.status })]
    );
    remediationNodeIds.set(remediation.id, rows[0].id);
    const findingNodeId = findingNodeIds.get(remediation.finding_id);
    if (findingNodeId) {
      await query(
        `INSERT INTO security_graph_edges (org_id, source_node_id, target_node_id, edge_type)
         VALUES ($1,$2,$3,'HAS_REMEDIATION') ON CONFLICT DO NOTHING`,
        [orgId, findingNodeId, rows[0].id]
      );
      await query(
        `INSERT INTO security_graph_edges (org_id, source_node_id, target_node_id, edge_type)
         VALUES ($1,$2,$3,'REMEDIATES') ON CONFLICT DO NOTHING`,
        [orgId, rows[0].id, findingNodeId]
      );
    }
  }
  const { rows: remediationDependencies } = await query(
    'SELECT remediation_id, depends_on_remediation_id FROM remediation_dependencies WHERE org_id = $1',
    [orgId]
  );
  for (const dependency of remediationDependencies) {
    const sourceNodeId = remediationNodeIds.get(dependency.remediation_id);
    const targetNodeId = remediationNodeIds.get(dependency.depends_on_remediation_id);
    if (sourceNodeId && targetNodeId) {
      await query(
        `INSERT INTO security_graph_edges (org_id, source_node_id, target_node_id, edge_type)
         VALUES ($1,$2,$3,'DEPENDS_ON') ON CONFLICT DO NOTHING`,
        [orgId, sourceNodeId, targetNodeId]
      );
    }
  }

  return {
    assetNodes: assetNodeIds.size,
    cyberEntityNodes: cyberNodeIds.size,
    controlNodes: controlNodeIds.size,
    findingNodes: findingNodeIds.size,
    vulnerabilityNodes: vulnNodeIds.size,
    evidenceNodes: evidenceRows.length,
    edges: relationships.length + cyberRelationships.length,
  };
}

export async function getKnowledgeGraph(orgId) {
  const [{ rows: nodes }, { rows: edges }] = await Promise.all([
    query('SELECT id, node_type, ref_id, label, metadata FROM security_graph_nodes WHERE org_id = $1 ORDER BY node_type, label', [orgId]),
    query('SELECT id, source_node_id, target_node_id, edge_type, metadata FROM security_graph_edges WHERE org_id = $1 ORDER BY edge_type, id', [orgId]),
  ]);
  return { graphVersion: 2, nodes, edges };
}

// Defensive attack-path analysis (spec section 31): "a vulnerability here --
// which critical systems could it affect indirectly?" BFS outward from the
// affected asset following structural edges only (HOSTS/DEPENDS_ON/
// CONNECTS_TO/CONTAINS/RUNS/EXPOSES) -- AFFECTED_BY edges are the leaves
// being asked about, not something to traverse further through.
const STRUCTURAL_EDGE_TYPES = new Set(['HOSTS', 'DEPENDS_ON', 'CONNECTS_TO', 'CONTAINS', 'RUNS', 'EXPOSES']);

// Shared read of the graph's structural adjacency + every ASSET node's
// identity/criticality, for anything that needs to walk the graph itself
// rather than ask a single reachability question (securityGraphOptimizer.js).
// Kept separate from findReachableAssets below so that function's existing
// callers/behavior are untouched.
export async function loadStructuralGraph(orgId) {
  const { rows: nodes } = await query(
    `SELECT n.id, n.ref_id AS asset_id, n.label, a.criticality
       FROM security_graph_nodes n
       JOIN assets a ON a.id = n.ref_id::uuid
      WHERE n.org_id = $1 AND n.node_type = 'ASSET'`,
    [orgId]
  );
  const nodesById = new Map(nodes.map((n) => [n.id, n]));

  const { rows: edges } = await query(
    'SELECT source_node_id, target_node_id, edge_type FROM security_graph_edges WHERE org_id = $1',
    [orgId]
  );
  const adjacency = new Map();
  for (const edge of edges) {
    if (!STRUCTURAL_EDGE_TYPES.has(edge.edge_type)) continue;
    if (!adjacency.has(edge.source_node_id)) adjacency.set(edge.source_node_id, []);
    adjacency.get(edge.source_node_id).push(edge.target_node_id);
  }

  // Asset -[AFFECTED_BY]-> Vulnerability edges, resolved back to the asset
  // node and the CVE label -- the entry points an attack-path analysis
  // starts from.
  const { rows: vulnEdges } = await query(
    `SELECT e.source_node_id AS asset_node_id, v.label AS cve_id, (e.metadata->>'riskScore')::numeric AS risk_score
       FROM security_graph_edges e
       JOIN security_graph_nodes v ON v.id = e.target_node_id AND v.node_type = 'VULNERABILITY'
      WHERE e.org_id = $1 AND e.edge_type = 'AFFECTED_BY'`,
    [orgId]
  );

  return { nodesById, adjacency, vulnEdges };
}

export async function findReachableAssets(orgId, startAssetId) {
  const { rows: startNodeRows } = await query(
    "SELECT id FROM security_graph_nodes WHERE org_id = $1 AND node_type = 'ASSET' AND ref_id = $2",
    [orgId, startAssetId]
  );
  if (startNodeRows.length === 0) return [];
  const startNodeId = startNodeRows[0].id;

  const { rows: edges } = await query(
    `SELECT source_node_id, target_node_id, edge_type FROM security_graph_edges WHERE org_id = $1`,
    [orgId]
  );

  const adjacency = new Map();
  for (const edge of edges) {
    if (!STRUCTURAL_EDGE_TYPES.has(edge.edge_type)) continue;
    if (!adjacency.has(edge.source_node_id)) adjacency.set(edge.source_node_id, []);
    adjacency.get(edge.source_node_id).push(edge.target_node_id);
  }

  const visited = new Set([startNodeId]);
  const queue = [startNodeId];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const next of adjacency.get(current) || []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  visited.delete(startNodeId);
  if (visited.size === 0) return [];

  const { rows: reachable } = await query(
    `SELECT n.ref_id AS asset_id, n.label, a.criticality
       FROM security_graph_nodes n
       JOIN assets a ON a.id = n.ref_id::uuid
      WHERE n.id = ANY($1) AND n.node_type = 'ASSET'`,
    [[...visited]]
  );
  return reachable;
}
