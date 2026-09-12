-- Crypto Discovery grows beyond TLS: SSH host keys (network probe, same
-- authorization bar), JWT signing algorithms and code-signing certificates
-- (both inspect crypto material the caller already possesses -- no network
-- probe, so no scope-authorization gate applies to those two).
ALTER TABLE crypto_findings DROP CONSTRAINT crypto_findings_source_check;
ALTER TABLE crypto_findings ADD CONSTRAINT crypto_findings_source_check
  CHECK (source IN ('TLS', 'SSH', 'JWT', 'CODE_SIGNING'));
