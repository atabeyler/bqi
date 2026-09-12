#!/usr/bin/env node
// Verifies and imports a signed Offline Intelligence Bundle. This is the
// ONLY way a Sovereign/air-gapped BCI instance's vulnerabilities knowledge
// base ever updates -- there is no live NVD/KEV/EPSS access to fall back
// to. An invalid signature imports nothing (fail closed), never a partial
// or best-effort import.
import { readFileSync } from 'node:fs';
import { importBundle } from '../src/services/bundle.js';
import { pool } from '../src/db/client.js';

const publicKeyPath = process.argv[2];
const bundlePath = process.argv[3];

if (!publicKeyPath || !bundlePath) {
  console.error('Usage: node scripts/bundle-import.js <public-key.pem> <bundle.json>');
  process.exit(1);
}

const publicKeyPem = readFileSync(publicKeyPath, 'utf8');
const signedBundle = JSON.parse(readFileSync(bundlePath, 'utf8'));

const result = await importBundle(signedBundle, publicKeyPem);
console.log(result);
await pool.end();

if (result.status === 'REJECTED') process.exit(1);
