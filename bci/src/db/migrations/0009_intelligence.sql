-- M8: Vulnerability Intelligence Platform. A local knowledge base built
-- from public sources (NVD, CISA KEV, FIRST EPSS) so BCI's Risk Engine
-- (M9) never has to trust a single feed live, and can still work from the
-- last-known-good snapshot when a source is unreachable (spec section 62:
-- show the user the snapshot's age rather than silently using stale data
-- as if it were fresh).

CREATE TABLE IF NOT EXISTS vulnerabilities (
  cve_id            TEXT PRIMARY KEY,
  description       TEXT,
  cwe_ids           TEXT[] NOT NULL DEFAULT '{}',
  cvss_vector       TEXT,
  cvss_score        NUMERIC,
  published_at      TIMESTAMPTZ,
  modified_at       TIMESTAMPTZ,
  kev               BOOLEAN NOT NULL DEFAULT false,
  kev_date_added    DATE,
  kev_due_date      DATE,
  epss_score        NUMERIC, -- 0..1 probability of exploitation in the next 30 days
  epss_percentile   NUMERIC, -- 0..1 rank against all scored CVEs
  epss_updated_at   TIMESTAMPTZ,
  source_data       JSONB NOT NULL DEFAULT '{}',
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per ingestion run, so a stale-but-working source is visible
-- ("last synced 6 days ago") instead of silently indistinguishable from a
-- fresh one.
CREATE TABLE IF NOT EXISTS intelligence_updates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source       TEXT NOT NULL, -- 'nvd', 'kev', 'epss'
  status       TEXT NOT NULL, -- SUCCESS, FAILED
  item_count   INTEGER,
  detail       TEXT,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT intelligence_updates_status_check CHECK (status IN ('SUCCESS', 'FAILED'))
);

CREATE INDEX IF NOT EXISTS idx_intelligence_updates_source ON intelligence_updates(source, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_vulnerabilities_kev ON vulnerabilities(kev) WHERE kev = true;
