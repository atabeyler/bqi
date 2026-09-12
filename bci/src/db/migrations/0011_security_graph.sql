-- M10: Security Graph. Deliberately projected FROM existing relational
-- data (assets, asset_relationships, findings/vulnerabilities) rather than
-- being a second place those facts have to be entered -- syncSecurityGraph()
-- rebuilds it from the tables that are already the source of truth.

CREATE TABLE IF NOT EXISTS security_graph_nodes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  node_type   TEXT NOT NULL, -- ASSET, VULNERABILITY, ...
  ref_id      TEXT NOT NULL, -- the underlying row's id (asset.id, or a CVE id for VULNERABILITY nodes)
  label       TEXT NOT NULL,
  metadata    JSONB NOT NULL DEFAULT '{}',
  UNIQUE (org_id, node_type, ref_id)
);

CREATE TABLE IF NOT EXISTS security_graph_edges (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_node_id   UUID NOT NULL REFERENCES security_graph_nodes(id) ON DELETE CASCADE,
  target_node_id   UUID NOT NULL REFERENCES security_graph_nodes(id) ON DELETE CASCADE,
  edge_type        TEXT NOT NULL, -- HOSTS, DEPENDS_ON, CONNECTS_TO, CONTAINS, RUNS, EXPOSES, AFFECTED_BY
  metadata         JSONB NOT NULL DEFAULT '{}',
  UNIQUE (org_id, source_node_id, target_node_id, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_security_graph_edges_source ON security_graph_edges(source_node_id);
CREATE INDEX IF NOT EXISTS idx_security_graph_edges_target ON security_graph_edges(target_node_id);
