-- M14: BQI (or any future gateway) integration. Marks a user as
-- provisioned by an external gateway rather than self-registered/bootstrapped
-- -- such a user has an unusable random password and must never be able to
-- log in via POST /api/v1/auth/login, only ever arrive via a verified
-- gateway token (see routes/gateway.js).
ALTER TABLE users ADD COLUMN IF NOT EXISTS external_source TEXT;
