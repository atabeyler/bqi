-- Remove the retired customer-hook/public-demonstration state from existing
-- installations. Migration 0035 is also hook-free for fresh installations;
-- IF EXISTS keeps this forward migration safe in both cases.
DROP INDEX IF EXISTS idx_controlled_proof_runs_org_public;

ALTER TABLE controlled_proof_runs
  DROP COLUMN IF EXISTS public_evidence_id,
  DROP COLUMN IF EXISTS public_proof_status,
  DROP COLUMN IF EXISTS public_visibility_verified,
  DROP COLUMN IF EXISTS public_hook,
  DROP COLUMN IF EXISTS public_evidence,
  DROP COLUMN IF EXISTS expires_at;
