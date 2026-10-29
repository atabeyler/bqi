-- BCI Verify runs live scanner engines (nuclei, naabu), whose binaries exist only in the
-- isolated worker image. The API enqueues a verification here and the worker executes it,
-- so the control plane never needs scanner binaries. Additive: scan_jobs is untouched.
CREATE TABLE IF NOT EXISTS verification_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  finding_id    UUID NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  requested_by  UUID NOT NULL REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'QUEUED',
  outcome       JSONB,
  locked_by     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT verification_jobs_status_check CHECK (status IN ('QUEUED', 'RUNNING', 'DONE'))
);

CREATE INDEX IF NOT EXISTS idx_verification_jobs_queued ON verification_jobs(created_at) WHERE status = 'QUEUED';
