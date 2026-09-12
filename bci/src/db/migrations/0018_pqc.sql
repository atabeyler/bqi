-- Post-Quantum Security Engine (spec section 20-25): Crypto Discovery +
-- Crypto Inventory. One row per real, observed cryptographic endpoint --
-- never a guess, never inferred from a target string without a probe.

CREATE TABLE IF NOT EXISTS crypto_findings (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  asset_id                UUID REFERENCES assets(id) ON DELETE SET NULL,
  source                  TEXT NOT NULL CHECK (source IN ('TLS')),
  target                  TEXT NOT NULL,
  protocol                TEXT,
  cipher_suite            TEXT,
  key_type                TEXT,
  key_size_bits           INTEGER,
  named_curve             TEXT,
  -- algorithm_id/quantum_vulnerable/classification_* come from
  -- src/quantum/pqcClassification.js at discovery time. quantum_vulnerable
  -- is nullable, not a boolean default -- NULL means "this table version
  -- has no basis to judge", which must never be treated as "safe".
  algorithm_id            TEXT NOT NULL,
  quantum_vulnerable      BOOLEAN,
  classification_note     TEXT,
  classification_version  TEXT NOT NULL,
  cert_subject            TEXT,
  cert_issuer             TEXT,
  cert_not_before         TIMESTAMPTZ,
  cert_not_after          TIMESTAMPTZ,
  cert_fingerprint        TEXT,
  discovered_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crypto_findings_org ON crypto_findings (org_id, discovered_at DESC);
CREATE INDEX IF NOT EXISTS idx_crypto_findings_vulnerable ON crypto_findings (org_id, quantum_vulnerable);
