-- SFRE production persistence (PostgreSQL). NOT exercised by automated tests in v1.0.0
-- (no PostgreSQL server in the CI/sandbox used for development); apply and test in staging before use.
CREATE TABLE IF NOT EXISTS sfre_snapshots (
  snapshot_id   TEXT PRIMARY KEY,
  content_hash  CHAR(64) NOT NULL,
  as_of         TIMESTAMPTZ NOT NULL,
  obs_count     INTEGER NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sfre_observations (
  hash            CHAR(64) PRIMARY KEY,
  snapshot_id     TEXT REFERENCES sfre_snapshots(snapshot_id),
  entity          TEXT NOT NULL,
  field           TEXT NOT NULL,
  value           JSONB,
  event_time      TIMESTAMPTZ NOT NULL,
  published_time  TIMESTAMPTZ NOT NULL,
  available_time  TIMESTAMPTZ NOT NULL,
  ingested_time   TIMESTAMPTZ NOT NULL,
  source          TEXT NOT NULL,
  revision        INTEGER NOT NULL,
  quality_flags   TEXT[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS sfre_obs_pit ON sfre_observations (entity, field, available_time);
CREATE TABLE IF NOT EXISTS sfre_runs (
  run_id        TEXT PRIMARY KEY,
  record        JSONB NOT NULL,
  result_hash   CHAR(64) NOT NULL,
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sfre_ledger (
  seq         BIGINT PRIMARY KEY,
  id          TEXT NOT NULL,
  entry       JSONB NOT NULL,
  prev_hash   CHAR(64) NOT NULL,
  hash        CHAR(64) NOT NULL
);
-- append-only enforcement
CREATE OR REPLACE FUNCTION sfre_no_mutation() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'sfre tables are append-only'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER sfre_ledger_ro BEFORE UPDATE OR DELETE ON sfre_ledger FOR EACH ROW EXECUTE FUNCTION sfre_no_mutation();
CREATE TRIGGER sfre_obs_ro BEFORE UPDATE OR DELETE ON sfre_observations FOR EACH ROW EXECUTE FUNCTION sfre_no_mutation();
CREATE TRIGGER sfre_runs_ro BEFORE UPDATE OR DELETE ON sfre_runs FOR EACH ROW EXECUTE FUNCTION sfre_no_mutation();
