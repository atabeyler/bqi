/**
 * Drizzle schema — mirrors the existing table structure (the
 * CREATE TABLE IF NOT EXISTS statements in server/src/services/database.js)
 * one-to-one. database.js remains the source of truth for the schema; this
 * file generates no migrations, it only provides a typed query layer.
 * approval_tokens is NOT here — kept out of scope along with auth.js.
 */
import { pgTable, serial, varchar, text, boolean, timestamp, jsonb, integer, uuid, bigint } from 'drizzle-orm/pg-core';

export const analyses = pgTable('analyses', {
  id: serial('id').primaryKey(),
  userCode: varchar('user_code', { length: 50 }).notNull(),
  category: varchar('category', { length: 50 }).notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  aiProvider: varchar('ai_provider', { length: 20 }),
  // Populated only for BDDK/BTK reports that ran the quantum kernel fraud
  // detector, so the fraud-trend view can aggregate without re-parsing
  // markdown -- see routes/analysis.js and routes/analysis.js's
  // /fraud-trend endpoint.
  fraudTransactionCount: integer('fraud_transaction_count'),
  fraudFlaggedCount: integer('fraud_flagged_count'),
  // User-set request metadata (see routes/analysis.js's /generate) -- priority
  // is a display-only urgency label; depth changes generation behavior
  // (web research pass, output length cap). See the matching ALTER TABLE
  // comments in services/database.js for what each value does.
  priority: varchar('priority', { length: 20 }).notNull().default('normal'),
  depth: varchar('depth', { length: 20 }).notNull().default('standart'),
  // The classification decided at generation time (classifyData() in
  // routes/analysis.js) -- NULL for rows written before this column existed
  // or by a writer that hasn't been updated. Readers must fall back to the
  // category floor for NULL, never treat NULL as PUBLIC -- see
  // history.js's blockedByClassification().
  dataClassification: varchar('data_classification', { length: 20 }),
  createdAt: timestamp('created_at').defaultNow(),
  // Desktop/multi-device sync metadata -- see routes/sync.js and
  // services/database.js for the matching ALTER TABLE statements.
  clientId: uuid('client_id'),
  deviceId: varchar('device_id', { length: 64 }).default('web'),
  version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at').defaultNow(),
  deletedAt: timestamp('deleted_at'),
  syncRevision: bigint('sync_revision', { mode: 'number' }),
});

export const devices = pgTable('devices', {
  id: serial('id').primaryKey(),
  deviceId: varchar('device_id', { length: 64 }).notNull().unique(),
  userCode: varchar('user_code', { length: 50 }).notNull(),
  deviceName: varchar('device_name', { length: 200 }),
  platform: varchar('platform', { length: 50 }),
  appVersion: varchar('app_version', { length: 20 }),
  authorizedAt: timestamp('authorized_at').defaultNow(),
  lastSeenAt: timestamp('last_seen_at').defaultNow(),
  revokedAt: timestamp('revoked_at'),
});

export const syncOperations = pgTable('sync_operations', {
  operationId: uuid('operation_id').primaryKey(),
  userCode: varchar('user_code', { length: 50 }).notNull(),
  deviceId: varchar('device_id', { length: 64 }).notNull(),
  entityType: varchar('entity_type', { length: 50 }).notNull(),
  entityClientId: uuid('entity_client_id'),
  op: varchar('op', { length: 20 }).notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  serverVersion: integer('server_version'),
  serverPayload: jsonb('server_payload'),
  error: text('error'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const messages = pgTable('messages', {
  id: serial('id').primaryKey(),
  fromUser: varchar('from_user', { length: 50 }).notNull(),
  toUser: varchar('to_user', { length: 50 }),
  message: text('message').notNull(),
  messageType: varchar('message_type', { length: 20 }).default('chat'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const emergencyLogs = pgTable('emergency_logs', {
  id: serial('id').primaryKey(),
  userCode: varchar('user_code', { length: 50 }),
  message: text('message').notNull(),
  target: varchar('target', { length: 50 }).notNull(),
  region: varchar('region', { length: 50 }),
  createdAt: timestamp('created_at').defaultNow(),
});

export const authUsers = pgTable('auth_users', {
  id: serial('id').primaryKey(),
  userCode: varchar('user_code', { length: 50 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  nickname: varchar('nickname', { length: 100 }),
  email: varchar('email', { length: 255 }),
  isAdmin: boolean('is_admin').default(false),
  blocked: boolean('blocked').default(false),
  createdAt: timestamp('created_at').defaultNow(),
});

export const userProfiles = pgTable('user_profiles', {
  id: serial('id').primaryKey(),
  userCode: varchar('user_code', { length: 50 }).notNull().unique(),
  displayName: varchar('display_name', { length: 100 }),
  rank: varchar('rank', { length: 100 }),
  unit: varchar('unit', { length: 200 }),
  preferredPersona: varchar('preferred_persona', { length: 50 }).default('general'),
  preferredLang: varchar('preferred_lang', { length: 5 }).default('tr'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const pushSubscriptions = pgTable('push_subscriptions', {
  id: serial('id').primaryKey(),
  userCode: varchar('user_code', { length: 50 }).notNull(),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

export const conversationMemory = pgTable('conversation_memory', {
  id: serial('id').primaryKey(),
  userCode: varchar('user_code', { length: 50 }).notNull(),
  sessionTitle: varchar('session_title', { length: 300 }),
  personaId: varchar('persona_id', { length: 50 }),
  summary: text('summary'),
  keyFacts: text('key_facts'),
  fullHistory: jsonb('full_history'),
  archived: boolean('archived').default(false),
  dataClassification: varchar('data_classification', { length: 20 }),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});
