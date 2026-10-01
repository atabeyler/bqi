-- SFRE persistence (PostgreSQL). Applied by PgStore.ensureSchema(); verified against PostgreSQL 16 by src/sfre/tests/pgStore.test.js.
CREATE TABLE IF NOT EXISTS sfre_observations (
  hash            CHAR(64) PRIMARY KEY,
  id              TEXT NOT NULL,
  entity          TEXT NOT NULL,
  field           TEXT NOT NULL,
  value           JSONB,
  unit            TEXT,
  event_time      TIMESTAMPTZ NOT NULL,
  published_time  TIMESTAMPTZ NOT NULL,
  available_time  TIMESTAMPTZ NOT NULL,
  ingested_time   TIMESTAMPTZ NOT NULL,
  source          TEXT NOT NULL,
  revision        INTEGER NOT NULL,
  quality_flags   TEXT[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS sfre_obs_pit ON sfre_observations (entity, field, available_time);
CREATE INDEX IF NOT EXISTS sfre_obs_avail ON sfre_observations (available_time);

CREATE TABLE IF NOT EXISTS sfre_records (
  collection  TEXT NOT NULL,
  id          TEXT NOT NULL,
  record      JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection, id)
);

CREATE TABLE IF NOT EXISTS sfre_ledger (
  seq        BIGINT PRIMARY KEY,
  id         TEXT NOT NULL,
  entry      JSONB NOT NULL,
  prev_hash  CHAR(64) NOT NULL,
  hash       CHAR(64) NOT NULL
);

-- governance state is the only mutable table; every record carries its own hash-chained history
CREATE TABLE IF NOT EXISTS sfre_models (
  key         TEXT PRIMARY KEY,
  record      JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION sfre_no_mutation() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'sfre table % is append-only', TG_TABLE_NAME; END; $$ LANGUAGE plpgsql;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'sfre_ledger_ro' AND tgrelid = 'sfre_ledger'::regclass) THEN CREATE TRIGGER sfre_ledger_ro BEFORE UPDATE OR DELETE ON sfre_ledger FOR EACH ROW EXECUTE FUNCTION sfre_no_mutation(); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'sfre_obs_ro' AND tgrelid = 'sfre_observations'::regclass) THEN CREATE TRIGGER sfre_obs_ro BEFORE UPDATE OR DELETE ON sfre_observations FOR EACH ROW EXECUTE FUNCTION sfre_no_mutation(); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'sfre_records_ro' AND tgrelid = 'sfre_records'::regclass) THEN CREATE TRIGGER sfre_records_ro BEFORE UPDATE OR DELETE ON sfre_records FOR EACH ROW EXECUTE FUNCTION sfre_no_mutation(); END IF;
END $$;
