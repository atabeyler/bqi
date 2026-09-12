-- Reports were org-wide only, with no way to say "this report is about
-- this asset" -- asset_id/scan_job_id are optional (a report generated
-- without a specific asset in mind stays org-wide, exactly as before;
-- nothing existing changes meaning). FULL is a new report_type that
-- bundles the other four builders' output into one artifact without
-- removing their independent use.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS asset_id UUID REFERENCES assets(id);
ALTER TABLE reports ADD COLUMN IF NOT EXISTS scan_job_id UUID REFERENCES scan_jobs(id);

ALTER TABLE reports DROP CONSTRAINT reports_type_check;
ALTER TABLE reports ADD CONSTRAINT reports_type_check CHECK (report_type IN (
  'EXECUTIVE', 'TECHNICAL', 'REMEDIATION', 'AUDIT', 'FULL'
));

CREATE INDEX IF NOT EXISTS idx_reports_asset_id ON reports(asset_id) WHERE asset_id IS NOT NULL;
