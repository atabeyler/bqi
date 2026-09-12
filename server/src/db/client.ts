/**
 * Drizzle client — reuses the existing pg Pool (database.js) instead of
 * opening a second connection pool. isDbConfigured() preserves the existing
 * "skip if DATABASE_URL is unset" pattern at every call site.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { getPool } from '../services/database.js';
import * as schema from './schema.js';

let dbInstance: ReturnType<typeof drizzle> | null = null;

export function isDbConfigured(): boolean {
  return !!process.env.DATABASE_URL;
}

export function getDb() {
  if (!isDbConfigured()) return null;
  if (!dbInstance) {
    dbInstance = drizzle(getPool(), { schema });
  }
  return dbInstance;
}
