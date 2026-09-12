-- M3: asset inventory. Deliberately minimal -- this is not yet the full
-- Security Graph (that's M10): asset_relationships here is just enough to
-- record "A hosts B" / "A depends_on B" facts for later graph-building.

CREATE TABLE IF NOT EXISTS assets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  asset_type   TEXT NOT NULL,
  criticality  TEXT NOT NULL DEFAULT 'MEDIUM',
  created_by   UUID NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assets_asset_type_check CHECK (asset_type IN (
    'DOMAIN', 'HOST', 'WEB_APP', 'API', 'REPOSITORY', 'CONTAINER',
    'CLOUD_RESOURCE', 'IDENTITY', 'SERVICE'
  )),
  CONSTRAINT assets_criticality_check CHECK (criticality IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL'))
);

CREATE TABLE IF NOT EXISTS asset_identifiers (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id         UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  identifier_type  TEXT NOT NULL, -- DOMAIN, IP, CIDR, REPO_URL, CLOUD_ACCOUNT_ID, ...
  value            TEXT NOT NULL,
  UNIQUE (asset_id, identifier_type, value)
);

CREATE TABLE IF NOT EXISTS asset_technologies (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id     UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  version      TEXT,
  detected_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS asset_relationships (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_asset_id    UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  target_asset_id    UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  relationship_type  TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT asset_relationships_type_check CHECK (relationship_type IN (
    'HOSTS', 'DEPENDS_ON', 'CONNECTS_TO', 'CONTAINS', 'RUNS', 'EXPOSES'
  )),
  CONSTRAINT asset_relationships_not_self CHECK (source_asset_id <> target_asset_id)
);

CREATE INDEX IF NOT EXISTS idx_assets_org_id ON assets(org_id);
CREATE INDEX IF NOT EXISTS idx_asset_identifiers_asset_id ON asset_identifiers(asset_id);
CREATE INDEX IF NOT EXISTS idx_asset_technologies_asset_id ON asset_technologies(asset_id);
CREATE INDEX IF NOT EXISTS idx_asset_relationships_org_id ON asset_relationships(org_id);
