-- A job whose analysisPlanner produced zero engines for its target type/
-- class (e.g. DOMAIN + PASSIVE -- planner.js's DOMAIN plan is SAFE_ACTIVE-
-- only) was previously marked COMPLETED like any real run, indistinguishable
-- from a genuine scan that found nothing. NO_COVERAGE is its own terminal
-- status: the job function did finish without erroring, but zero engines
-- ever actually ran, so "0 findings" here must never be shown as "clean".
ALTER TABLE scan_jobs DROP CONSTRAINT scan_jobs_status_check;

ALTER TABLE scan_jobs ADD CONSTRAINT scan_jobs_status_check CHECK (status IN (
  'QUEUED', 'DISCOVERY', 'ANALYZING', 'NORMALIZING', 'VERIFYING',
  'CORRELATING', 'SCORING', 'REPORTING', 'COMPLETED', 'NO_COVERAGE',
  'FAILED', 'CANCELLED', 'TIMED_OUT'
));
