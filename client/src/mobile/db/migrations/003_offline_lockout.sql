-- Offline login used to allow unlimited bcrypt attempts against the cached
-- password hash (client/src/mobile/auth/session.js) with no expiry on the
-- cached credential itself -- a lost/stolen device with no PIN/biometric
-- lock of its own could be brute-forced offline indefinitely. These columns
-- back a per-device attempt counter with backoff and cap how long a cached
-- offline session stays usable at all.
ALTER TABLE device_meta ADD COLUMN failed_offline_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE device_meta ADD COLUMN offline_locked_until TEXT;
