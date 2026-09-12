#!/usr/bin/env node
// Exports the current vulnerabilities knowledge base as a signed Offline
// Intelligence Bundle. Run on an internet-connected BCI instance that has
// been syncing NVD/KEV/EPSS (M8); ship the output file to an air-gapped
// instance and import it with bundle-import.js there.
import { readFileSync, writeFileSync } from 'node:fs';
import { exportBundle } from '../src/services/bundle.js';
import { pool } from '../src/db/client.js';

const privateKeyPath = process.argv[2];
const outputPath = process.argv[3] || `bci-intelligence-bundle-${new Date().toISOString().slice(0, 10)}.json`;

if (!privateKeyPath) {
  console.error('Usage: node scripts/bundle-export.js <private-key.pem> [output.json]');
  process.exit(1);
}

const privateKeyPem = readFileSync(privateKeyPath, 'utf8');
const bundle = await exportBundle(privateKeyPem);
writeFileSync(outputPath, JSON.stringify(bundle, null, 2));

console.log(`Exported ${bundle.payload.vulnerabilities.length} vulnerabilities to ${outputPath}`);
await pool.end();
