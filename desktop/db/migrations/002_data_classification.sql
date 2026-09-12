-- Local mirror of the server's analyses.data_classification column (see
-- server/src/services/database.js's matching ALTER TABLE) -- without this,
-- a report's classification decided at generation time was only ever
-- carried through category, so it could read back at a lower, re-derived
-- floor after a sync pull just as it could on the server before that fix.
ALTER TABLE analyses ADD COLUMN data_classification TEXT;
