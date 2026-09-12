-- Soft-archive for scan_jobs: hides a job from the default list view
-- without ever deleting the row. BCI's audit/compliance design is
-- deliberately append-only end to end (audit_events, reports, findings --
-- see README's "the report IS the compliance evidence") and scans are no
-- exception: there is intentionally no DELETE endpoint anywhere in this
-- codebase for a scan_jobs row. Archiving only sets a timestamp; the job,
-- its engine runs, and everything it produced remain exactly as they were
-- and stay reachable via GET /scans/:id and friends.
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
