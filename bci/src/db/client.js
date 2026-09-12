import pg from 'pg';
import fs from 'node:fs';
import { config } from '../config.js';

const { Pool, types } = pg;

// PostgreSQL DATE has no timezone. node-postgres otherwise materializes it at
// local midnight, so serializing the same calendar date from a positive UTC
// offset can incorrectly produce the previous day. Keep date-only values
// stable across developer machines and deployments by parsing them at UTC.
types.setTypeParser(1082, (value) => new Date(`${value}T00:00:00.000Z`));

const ssl = config.databaseCaCert
  ? { ca: fs.readFileSync(config.databaseCaCert, 'utf8'), rejectUnauthorized: true }
  : undefined;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl,
});

pool.on('error', (err) => {
  // A broken idle client must not crash the process — log and let the pool
  // recycle the connection on next checkout.
  console.error('BCI database pool error on idle client', err);
});

export async function query(text, params) {
  return pool.query(text, params);
}

export async function checkDatabaseHealth() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
