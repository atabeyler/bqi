#!/usr/bin/env node
// Generates a CHECKSUMS.txt (SHA-256, one line per file) for a release
// artifact directory. This is the release-integrity primitive spec section
// 46/49 asks for; wiring it into an actual code-signing certificate/CI
// pipeline is a deployment-specific decision left to whoever operates that
// pipeline, not something this script can honestly fake in the abstract.
import { readdirSync, statSync, createReadStream, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const targetDir = process.argv[2];
if (!targetDir) {
  console.error('Usage: node scripts/generate-checksums.js <directory>');
  process.exit(1);
}

function listFiles(dir, base = dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return listFiles(full, base);
    return [path.relative(base, full)];
  });
}

async function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

const files = listFiles(targetDir).sort();
const lines = [];
for (const relPath of files) {
  const digest = await sha256(path.join(targetDir, relPath));
  lines.push(`${digest}  ${relPath}`);
}

const outPath = path.join(targetDir, 'CHECKSUMS.txt');
writeFileSync(outPath, lines.join('\n') + '\n');
console.log(`Wrote ${files.length} checksums to ${outPath}`);
