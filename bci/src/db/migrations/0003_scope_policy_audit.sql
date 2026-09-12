-- M2: authorized scopes (the only thing that can turn active analysis on),
-- scan policies, and the append-only audit ledger.

CREATE TABLE IF NOT EXISTS authorized_scopes (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                   TEXT NOT NULL,
  target                 TEXT NOT NULL, -- domain, CIDR, repo URL, cloud project id, etc.
  allowed_scan_classes   TEXT[] NOT NULL DEFAULT '{}', -- e.g. PASSIVE, SAFE_ACTIVE, AUTHENTICATED, RESTRICTED
  intrusiveness          TEXT NOT NULL DEFAULT 'PASSIVE',
  valid_from             TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until            TIMESTAMPTZ,
  status                 TEXT NOT NULL DEFAULT 'PENDING', -- PENDING, APPROVED, REJECTED, REVOKED, EXPIRED
  created_by             UUID NOT NULL REFERENCES users(id),
  approved_by            UUID REFERENCES users(id),
  approved_at            TIMESTAMPTZ,
  policy_version         INTEGER NOT NULL DEFAULT 1,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT authorized_scopes_status_check
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'REVOKED', 'EXPIRED')),
  CONSTRAINT authorized_scopes_intrusiveness_check
    CHECK (intrusiveness IN ('PASSIVE', 'SAFE_ACTIVE', 'AUTHENTICATED', 'RESTRICTED'))
);

CREATE TABLE IF NOT EXISTS scope_exclusions (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id  UUID NOT NULL REFERENCES authorized_scopes(id) ON DELETE CASCADE,
  pattern   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_policies (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  safe_mode   TEXT NOT NULL DEFAULT 'PASSIVE_SAFE_ACTIVE',
  config      JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Audit ledger. Application code only ever INSERTs here (see
-- src/services/audit.js) -- no route exposes UPDATE/DELETE. Real tamper
-- resistance (DB-role write privilege restriction, WORM storage) is an
-- enterprise-hardening item tracked for M16, not implemented at this stage.
CREATE TABLE IF NOT EXISTS audit_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID REFERENCES organizations(id) ON DELETE SET NULL,
  actor_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  action         TEXT NOT NULL,
  target_type    TEXT,
  target_id      TEXT,
  result         TEXT NOT NULL, -- ALLOW, DENY, SUCCESS, FAILURE
  metadata       JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_authorized_scopes_org_id ON authorized_scopes(org_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_org_id ON audit_events(org_id, created_at DESC);
