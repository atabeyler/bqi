import pkg from 'pg';
import { randomUUID } from 'crypto';
import { logger } from '../lib/logger.js';
import { recordRequestMetric } from '../lib/requestMetrics.js';
const { Pool } = pkg;

let pool;

// item 11 was reverted after a real production outage (2026-08-28): making
// this a hard startup refusal assumed an operator can always obtain their
// provider's CA cert for verified TLS, but Render (this deployment's DB
// provider) does not publish one for external (non-Render-hosted)
// connections -- there is no documented, supported way to satisfy this
// requirement for a Render-DB-plus-external-server topology like this
// project's (server on Northflank, DB on Render). The fail-closed throw
// below made the server unable to boot AT ALL from the moment it deployed
// until this revert. Back to the original, deliberate tradeoff: encrypted
// but unverified (rejectUnauthorized: false) when no CA cert is configured,
// with an operator who DOES have a CA cert (e.g. a provider that publishes
// one) still able to opt into verified TLS by setting DATABASE_CA_CERT.
function buildSslConfig() {
  if (process.env.NODE_ENV !== 'production') return false;
  const caCert = process.env.DATABASE_CA_CERT;
  if (caCert) {
    return { rejectUnauthorized: true, ca: caCert };
  }
  logger.warn('DATABASE_CA_CERT not set — Postgres TLS connections are encrypted but unverified (MITM risk); see database.js comment for why this is not fail-closed.');
  return { rejectUnauthorized: false };
}

export function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Render's managed Postgres (and most managed Postgres providers)
      // present a certificate that isn't in Node's default trust store, so
      // rejectUnauthorized: true here made every connection attempt hang
      // indefinitely instead of failing -- which in turn blocked
      // initDatabase() from ever settling, and index.js never reached
      // server.listen() (see the 2026-07-21 outage). DATABASE_CA_CERT (PEM,
      // e.g. Render's CA bundle) lets an operator opt back into verified TLS
      // once it's confirmed stable for this deployment; without it, this
      // stays the documented tradeoff (encrypted but unverified) rather than
      // silently upgrading and risking the same outage again.
      ssl: buildSslConfig(),
      max: 10,
      idleTimeoutMillis: 30000,
      // A bounded connection attempt, so any future DB connectivity problem
      // fails fast into index.js's initDatabase().catch() fallback (which
      // still calls server.listen()) instead of hanging the process and
      // preventing the port from ever binding.
      connectionTimeoutMillis: 10000,
    });
    // node-postgres emits 'error' on the Pool when an IDLE client's
    // underlying connection dies (e.g. the far side -- Render Postgres,
    // reached cross-cloud from this Northflank deployment -- resets a
    // connection our 20s keep-alive ping (see index.js) is holding open).
    // That event has no default handler, and an unhandled 'error' event in
    // Node crashes the entire process -- which is what was actually causing
    // the repeated pod restarts, not an unrelated OOM. Logging it here is
    // enough: the pool discards the dead client and opens a fresh one on
    // the next query on its own.
    pool.on('error', (err) => {
      logger.warn({ err }, '[DB] Idle client connection error (pool will reconnect)');
    });
  }
  return pool;
}

export async function initDatabase() {
  if (!process.env.DATABASE_URL) {
    logger.warn('DATABASE_URL not set — DB disabled');
    return;
  }

  const p = getPool();

  await p.query(`
    CREATE TABLE IF NOT EXISTS approval_tokens (
      id SERIAL PRIMARY KEY,
      token VARCHAR(255) UNIQUE NOT NULL,
      user_code VARCHAR(50) NOT NULL,
      approved BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW(),
      expires_at TIMESTAMP NOT NULL
    );
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS analyses (
      id SERIAL PRIMARY KEY,
      user_code VARCHAR(50) NOT NULL,
      category VARCHAR(50) NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      ai_provider VARCHAR(20),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // analyses may already exist from before the fraud-trend columns were
  // added -- populated only for BDDK/BTK reports that ran the quantum
  // kernel fraud detector (see routes/analysis.js), NULL otherwise.
  await p.query(`ALTER TABLE analyses ADD COLUMN IF NOT EXISTS fraud_transaction_count INTEGER;`);
  await p.query(`ALTER TABLE analyses ADD COLUMN IF NOT EXISTS fraud_flagged_count INTEGER;`);

  // Desktop/multi-device sync metadata (see routes/sync.js). client_id is a
  // stable identifier the *client* generates at create time (so an offline
  // desktop write already has a durable id before it ever reaches the
  // server); version + sync_revision drive optimistic-concurrency conflict
  // detection and the pull cursor respectively. Generated with
  // crypto.randomUUID() in application code below rather than a DB-side
  // gen_random_uuid() default, since that requires either Postgres 13+ or
  // the pgcrypto extension and managed Postgres providers don't always grant
  // CREATE EXTENSION -- this way no DB-side assumption is needed at all.
  await p.query(`ALTER TABLE analyses ADD COLUMN IF NOT EXISTS client_id UUID;`);
  await p.query(`ALTER TABLE analyses ADD COLUMN IF NOT EXISTS device_id VARCHAR(64) DEFAULT 'web';`);
  await p.query(`ALTER TABLE analyses ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;`);
  await p.query(`ALTER TABLE analyses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();`);
  await p.query(`ALTER TABLE analyses ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;`);
  await p.query(`CREATE SEQUENCE IF NOT EXISTS analyses_sync_revision_seq;`);
  await p.query(`ALTER TABLE analyses ADD COLUMN IF NOT EXISTS sync_revision BIGINT;`);
  await p.query(`ALTER TABLE analyses ALTER COLUMN sync_revision SET DEFAULT nextval('analyses_sync_revision_seq');`);
  await p.query(`ALTER SEQUENCE analyses_sync_revision_seq OWNED BY analyses.sync_revision;`);
  await backfillAnalysesSyncMetadata(p);
  await p.query(`ALTER TABLE analyses ALTER COLUMN sync_revision SET NOT NULL;`);
  await p.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_analyses_client_id ON analyses(client_id);`);
  await p.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_analyses_sync_revision ON analyses(sync_revision);`);

  // priority: a user-set urgency label on the request (see routes/analysis.js's
  // /generate) -- surfaced in history/feed so a "kritik" request stands out
  // from routine ones; does not change how the analysis itself runs.
  // depth: unlike priority, this DOES change generation -- 'hizli' skips the
  // web-research pass and caps AI output shorter, 'derin' forces web research
  // on and raises the output cap; 'standart' is today's existing behavior
  // (see routes/analysis.js's /generate, resolveDepthSettings()).
  await p.query(`ALTER TABLE analyses ADD COLUMN IF NOT EXISTS priority VARCHAR(20) NOT NULL DEFAULT 'normal';`);
  await p.query(`ALTER TABLE analyses ADD COLUMN IF NOT EXISTS depth VARCHAR(20) NOT NULL DEFAULT 'standart';`);

  // The classification decided at generation time (see routes/analysis.js's
  // classifyData() call in /generate) used to be re-derived from `category`
  // on every read instead of stored -- so a report explicitly raised to
  // RESTRICTED at creation could read back as a lower, category-derived
  // floor later (history.js, sync, downloads). NULL here means "no stored
  // value yet" (rows written before this migration, or writers that haven't
  // been updated to pass one) -- readers must still fall back to the
  // category floor for NULL, never treat NULL as PUBLIC.
  await p.query(`ALTER TABLE analyses ADD COLUMN IF NOT EXISTS data_classification VARCHAR(20);`);

  await p.query(`
    CREATE TABLE IF NOT EXISTS devices (
      id SERIAL PRIMARY KEY,
      device_id VARCHAR(64) UNIQUE NOT NULL,
      user_code VARCHAR(50) NOT NULL,
      device_name VARCHAR(200),
      platform VARCHAR(50),
      app_version VARCHAR(20),
      authorized_at TIMESTAMP DEFAULT NOW(),
      last_seen_at TIMESTAMP DEFAULT NOW(),
      revoked_at TIMESTAMP
    );
  `);

  // Idempotency ledger for /api/sync/push -- a push retried after a dropped
  // response (client never saw the result) replays the same operation_id and
  // gets the originally-recorded result back instead of double-applying.
  await p.query(`
    CREATE TABLE IF NOT EXISTS sync_operations (
      operation_id UUID PRIMARY KEY,
      user_code VARCHAR(50) NOT NULL,
      device_id VARCHAR(64) NOT NULL,
      entity_type VARCHAR(50) NOT NULL,
      entity_client_id UUID,
      op VARCHAR(20) NOT NULL,
      status VARCHAR(20) NOT NULL,
      server_version INTEGER,
      server_payload JSONB,
      error TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_code);
    CREATE INDEX IF NOT EXISTS idx_sync_operations_user ON sync_operations(user_code);
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      from_user VARCHAR(50) NOT NULL,
      to_user VARCHAR(50),
      message TEXT NOT NULL,
      message_type VARCHAR(20) DEFAULT 'chat',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS emergency_logs (
      id SERIAL PRIMARY KEY,
      user_code VARCHAR(50),
      message TEXT NOT NULL,
      target VARCHAR(50) NOT NULL,
      region VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Ownership/classification record for uploaded files (routes/files.js).
  // Uploads previously had no DB row at all -- the random UUID filename was
  // the only "access control," so any authenticated user who obtained/
  // guessed a filename could download it regardless of who uploaded it. A
  // row here lets the download route enforce owner-or-classification-access
  // instead. Rows for files uploaded before this migration don't exist --
  // files.js treats a missing row as pre-migration legacy content and
  // allows the existing (any-authenticated-user) behavior only for those,
  // never for a filename that does have a row.
  await p.query(`
    CREATE TABLE IF NOT EXISTS uploaded_files (
      filename VARCHAR(255) PRIMARY KEY,
      owner_user_code VARCHAR(50) NOT NULL,
      classification VARCHAR(20) NOT NULL DEFAULT 'INTERNAL',
      original_name TEXT,
      mimetype VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS auth_users (
      id SERIAL PRIMARY KEY,
      user_code VARCHAR(50) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      nickname VARCHAR(100),
      is_admin BOOLEAN DEFAULT FALSE,
      blocked BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // auth_users may already exist from before the "blocked"/"email" columns were added.
  await p.query(`ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS blocked BOOLEAN DEFAULT FALSE;`);
  await p.query(`ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS email VARCHAR(255);`);
  // Abstract RBAC role (admin/analyst/viewer, see lib/rbac.js) -- distinct
  // from is_admin, which stays the source of truth for the 'admin' role so
  // existing admin accounts and login logic are unaffected. Non-admin
  // accounts default to 'analyst' (the same access level they already had).
  await p.query(`ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'analyst';`);

  // Registered WebAuthn/passkey authenticators (see routes/webauthn.js).
  // Only public data ever lands here: credential_id + public_key are what
  // the authenticator itself hands back during registration, counter is a
  // signature-replay guard, transports is a UI hint. No private key and no
  // biometric data ever exists server-side -- the platform authenticator
  // (Face ID/Touch ID/Windows Hello/Android biometrics) verifies the user
  // locally and never sends that result to this API; only the signed
  // challenge response does, which is verified purely cryptographically.
  await p.query(`
    CREATE TABLE IF NOT EXISTS webauthn_credentials (
      id SERIAL PRIMARY KEY,
      user_code VARCHAR(50) NOT NULL,
      credential_id TEXT UNIQUE NOT NULL,
      public_key TEXT NOT NULL,
      counter BIGINT NOT NULL DEFAULT 0,
      device_name VARCHAR(200),
      device_type VARCHAR(20),
      backed_up BOOLEAN DEFAULT FALSE,
      transports VARCHAR(200),
      created_at TIMESTAMP DEFAULT NOW(),
      last_used_at TIMESTAMP
    );
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      user_code VARCHAR(50) NOT NULL,
      endpoint TEXT UNIQUE NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id SERIAL PRIMARY KEY,
      actor_user_code VARCHAR(50) NOT NULL,
      actor_nickname VARCHAR(100),
      action VARCHAR(50) NOT NULL,
      target_user_code VARCHAR(50),
      details JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_analyses_user ON analyses(user_code);
    CREATE INDEX IF NOT EXISTS idx_analyses_user_sync_revision ON analyses(user_code, sync_revision);
    CREATE INDEX IF NOT EXISTS idx_messages_users ON messages(from_user, to_user);
    CREATE INDEX IF NOT EXISTS idx_tokens_token ON approval_tokens(token);
    CREATE INDEX IF NOT EXISTS idx_audit_log_created ON admin_audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON admin_audit_log(actor_user_code);
    CREATE INDEX IF NOT EXISTS idx_audit_log_target ON admin_audit_log(target_user_code);
    CREATE INDEX IF NOT EXISTS idx_auth_users_code ON auth_users(user_code);
    CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user ON webauthn_credentials(user_code);
  `);

  logger.info('Database tables ready');
}

// Fills client_id/sync_revision for rows that predate the sync columns
// above. Only ever touches rows still missing that metadata, so after the
// first successful run on a given database this is a no-op query on every
// later boot.
async function backfillAnalysesSyncMetadata(p) {
  const { rows } = await p.query(
    `SELECT id FROM analyses WHERE client_id IS NULL OR sync_revision IS NULL`
  );
  if (!rows.length) return;
  // One batched UPDATE instead of one round-trip per row. client_id is
  // still generated application-side with crypto.randomUUID() (see the
  // comment above the client_id column, ~line 87) rather than DB-side
  // gen_random_uuid(), for the same reason: no PG13+/pgcrypto assumption.
  // unnest() pairs each id with its own generated client_id in one pass.
  const ids = rows.map((row) => row.id);
  const clientIds = rows.map(() => randomUUID());
  await p.query(
    `UPDATE analyses AS a
     SET client_id = COALESCE(a.client_id, v.client_id),
         sync_revision = COALESCE(a.sync_revision, nextval('analyses_sync_revision_seq'))
     FROM (SELECT unnest($1::int[]) AS id, unnest($2::uuid[]) AS client_id) AS v
     WHERE a.id = v.id`,
    [ids, clientIds]
  );
  logger.info({ count: rows.length }, '[Database] Backfilled analyses sync metadata');
}

export async function query(text, params) {
  const p = getPool();
  const startedAt = Date.now();
  try {
    const result = await p.query(text, params);
    recordRequestMetric('db.query', Date.now() - startedAt, 200);
    return result;
  } catch (err) {
    recordRequestMetric('db.query', Date.now() - startedAt, 500);
    throw err;
  }
}

// Email notification recipients -- users who are offline/inactive still need
// a way to see emergency broadcasts, direct messages, and meeting-start
// alerts, so these back the "also email everyone, active or not" behavior
// in routes/emergency.js and services/socket.js.
export async function getUserEmailRecipients() {
  if (!process.env.DATABASE_URL) return [];
  try {
    const { rows } = await query("SELECT user_code, nickname, email FROM auth_users WHERE email IS NOT NULL AND email <> ''");
    return rows;
  } catch (err) {
    logger.warn({ err }, '[Database] Failed to load user email recipients');
    return [];
  }
}

// Records who uploaded a file and at what classification -- see the
// uploaded_files table comment above. Best-effort: a logging failure here
// must not fail the upload itself (the file is already saved/on S3 by the
// time this runs), but files.js's download route treats a missing row as
// "pre-migration legacy," not "public," so a failed insert here does
// weaken this specific file's ACL back to the old any-authenticated-user
// behavior -- acceptable degradation, not a silent full bypass.
export async function recordUploadedFile({ filename, ownerUserCode, classification, originalName, mimetype }) {
  if (!process.env.DATABASE_URL) return;
  try {
    await query(
      `INSERT INTO uploaded_files (filename, owner_user_code, classification, original_name, mimetype)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (filename) DO NOTHING`,
      [filename, ownerUserCode, classification || 'INTERNAL', originalName || null, mimetype || null]
    );
  } catch (err) {
    logger.warn({ err }, '[Database] Failed to record uploaded file ownership');
  }
}

// Deliberately lets a query failure propagate instead of swallowing it into
// a null return: the caller (routes/files.js's GET /:filename) treats a
// null record as "this file predates the ownership migration, fall back to
// legacy any-authenticated-user access" -- collapsing "genuinely no record"
// and "the lookup itself failed" into the same null used to let a
// transient DB error silently grant that same no-ACL fallback to every
// file, including ones that DO have an owner/classification on record.
export async function getUploadedFileRecord(filename) {
  if (!process.env.DATABASE_URL) return null;
  const { rows } = await query(
    'SELECT filename, owner_user_code, classification FROM uploaded_files WHERE filename = $1',
    [filename]
  );
  return rows[0] || null;
}

export async function getUserEmailByNickname(nickname) {
  if (!process.env.DATABASE_URL || !nickname) return null;
  try {
    const { rows } = await query(
      "SELECT email FROM auth_users WHERE nickname = $1 AND email IS NOT NULL AND email <> '' LIMIT 1",
      [nickname]
    );
    return rows[0]?.email || null;
  } catch (err) {
    logger.warn({ err }, '[Database] Failed to load user email by nickname');
    return null;
  }
}

// Best-effort admin action trail -- never blocks the action it's logging on failure.
export async function logAuditEvent(actor, action, targetUserCode = null, details = null) {
  if (!process.env.DATABASE_URL) return;
  try {
    await query(
      'INSERT INTO admin_audit_log (actor_user_code, actor_nickname, action, target_user_code, details) VALUES ($1, $2, $3, $4, $5::jsonb)',
      [actor.userCode, actor.nickname || null, action, targetUserCode, details ? JSON.stringify(details) : null]
    );
  } catch (err) {
    logger.warn({ err, action }, '[AuditLog] write failed');
  }
}

// Memory tables — for subsequent sessions
export async function initMemoryTables() {
  if (!process.env.DATABASE_URL) return;
  const p = getPool();

  await p.query(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      id SERIAL PRIMARY KEY,
      user_code VARCHAR(50) UNIQUE NOT NULL,
      display_name VARCHAR(100),
      rank VARCHAR(100),
      unit VARCHAR(200),
      preferred_persona VARCHAR(50) DEFAULT 'general',
      preferred_lang VARCHAR(5) DEFAULT 'tr',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS conversation_memory (
      id SERIAL PRIMARY KEY,
      user_code VARCHAR(50) NOT NULL,
      session_title VARCHAR(300),
      persona_id VARCHAR(50),
      summary TEXT,
      key_facts TEXT,
      full_history JSONB,
      archived BOOLEAN DEFAULT FALSE,
      data_classification VARCHAR(20),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // item 19: an already-deployed DB won't have the column above -- same
  // never-downgrade-safe NULL fallback as the analyses table's own
  // migration (readers must floor NULL to classifyData(null, ...), never
  // treat it as PUBLIC).
  await p.query(`ALTER TABLE conversation_memory ADD COLUMN IF NOT EXISTS data_classification VARCHAR(20);`);

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_memory_user ON conversation_memory(user_code);
    CREATE INDEX IF NOT EXISTS idx_profiles_user ON user_profiles(user_code);
  `);

  logger.info('Memory tables ready');
}
