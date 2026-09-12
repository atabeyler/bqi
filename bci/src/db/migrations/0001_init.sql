-- BCI Foundation migration.
-- Domain entities (organizations, users, RBAC, assets, scopes, findings, ...)
-- land in later milestones (M2+). This migration only proves the migration
-- pipeline works and records the platform's own bootstrap fact.

CREATE TABLE IF NOT EXISTS system_info (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO system_info (key, value)
VALUES ('bci_platform_version', '0.1.0')
ON CONFLICT (key) DO NOTHING;
