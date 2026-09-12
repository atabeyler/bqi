-- M2: organizations, users, RBAC catalog (roles/permissions), role assignments.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS organizations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email          TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  blocked        BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, email)
);

-- Static role catalog. Row-per-role rather than a free-text column so
-- role_permissions can foreign-key into it and an unknown role id is a hard
-- schema error rather than a silently-ignored typo.
CREATE TABLE IF NOT EXISTS roles (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS permissions (
  id  TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id        TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id  TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- Role assignment is per-organization: the same user id could in principle
-- be invited into more than one tenant, and a role held in org A must never
-- imply access in org B.
CREATE TABLE IF NOT EXISTS user_roles (
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role_id  TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, org_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_users_org_id ON users(org_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_user_org ON user_roles(user_id, org_id);

-- Seed the role/permission catalog. Idempotent so re-running (or a future
-- migration that adds a permission) never conflicts with existing rows.
INSERT INTO roles (id, name) VALUES
  ('viewer',         'BCI Viewer'),
  ('analyst',        'BCI Analyst'),
  ('operator',       'BCI Operator'),
  ('security_admin', 'BCI Security Admin'),
  ('auditor',        'BCI Auditor'),
  ('system_admin',   'BCI System Admin')
ON CONFLICT (id) DO NOTHING;

INSERT INTO permissions (id) VALUES
  ('asset:view'), ('asset:create'), ('asset:update'),
  ('scope:view'), ('scope:create'), ('scope:approve'),
  ('scan:view'), ('scan:create'), ('scan:cancel'),
  ('finding:view'), ('finding:update'), ('finding:verify'),
  ('evidence:view'),
  ('report:view'), ('report:export'),
  ('rule:view'), ('rule:manage'),
  ('intel:view'), ('intel:manage'),
  ('audit:view'),
  ('system:manage')
ON CONFLICT (id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id) VALUES
  ('viewer', 'asset:view'), ('viewer', 'scope:view'), ('viewer', 'scan:view'),
  ('viewer', 'finding:view'), ('viewer', 'evidence:view'), ('viewer', 'report:view'),
  ('viewer', 'rule:view'), ('viewer', 'intel:view'),

  ('analyst', 'asset:view'), ('analyst', 'scope:view'), ('analyst', 'scan:view'),
  ('analyst', 'finding:view'), ('analyst', 'finding:update'), ('analyst', 'finding:verify'),
  ('analyst', 'evidence:view'), ('analyst', 'report:view'), ('analyst', 'report:export'),
  ('analyst', 'rule:view'), ('analyst', 'intel:view'),

  ('operator', 'asset:view'), ('operator', 'asset:create'), ('operator', 'asset:update'),
  ('operator', 'scope:view'), ('operator', 'scope:create'),
  ('operator', 'scan:view'), ('operator', 'scan:create'), ('operator', 'scan:cancel'),
  ('operator', 'finding:view'), ('operator', 'finding:update'), ('operator', 'finding:verify'),
  ('operator', 'evidence:view'), ('operator', 'report:view'), ('operator', 'report:export'),
  ('operator', 'rule:view'), ('operator', 'intel:view'),

  ('security_admin', 'asset:view'), ('security_admin', 'asset:create'), ('security_admin', 'asset:update'),
  ('security_admin', 'scope:view'), ('security_admin', 'scope:create'), ('security_admin', 'scope:approve'),
  ('security_admin', 'scan:view'), ('security_admin', 'scan:create'), ('security_admin', 'scan:cancel'),
  ('security_admin', 'finding:view'), ('security_admin', 'finding:update'), ('security_admin', 'finding:verify'),
  ('security_admin', 'evidence:view'), ('security_admin', 'report:view'), ('security_admin', 'report:export'),
  ('security_admin', 'rule:view'), ('security_admin', 'rule:manage'),
  ('security_admin', 'intel:view'), ('security_admin', 'intel:manage'),

  ('auditor', 'asset:view'), ('auditor', 'scope:view'), ('auditor', 'scan:view'),
  ('auditor', 'finding:view'), ('auditor', 'evidence:view'), ('auditor', 'report:view'),
  ('auditor', 'audit:view'),

  ('system_admin', 'asset:view'), ('system_admin', 'asset:create'), ('system_admin', 'asset:update'),
  ('system_admin', 'scope:view'), ('system_admin', 'scope:create'), ('system_admin', 'scope:approve'),
  ('system_admin', 'scan:view'), ('system_admin', 'scan:create'), ('system_admin', 'scan:cancel'),
  ('system_admin', 'finding:view'), ('system_admin', 'finding:update'), ('system_admin', 'finding:verify'),
  ('system_admin', 'evidence:view'), ('system_admin', 'report:view'), ('system_admin', 'report:export'),
  ('system_admin', 'rule:view'), ('system_admin', 'rule:manage'),
  ('system_admin', 'intel:view'), ('system_admin', 'intel:manage'),
  ('system_admin', 'audit:view'), ('system_admin', 'system:manage')
ON CONFLICT DO NOTHING;
