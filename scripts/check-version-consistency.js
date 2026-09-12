#!/usr/bin/env node
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const readJson = (p) => JSON.parse(readFileSync(path.join(root, p), 'utf8'));

const packageTargets = ['package.json', 'client/package.json', 'server/package.json'];
const versions = packageTargets.map((p) => readJson(p).version);
const canonical = versions[0];
if (!canonical || versions.some((v) => v !== canonical)) {
  console.error('Version mismatch across release package.json files:');
  packageTargets.forEach((file, i) => console.error(`  ${file}: ${versions[i]}`));
  process.exit(1);
}

const lockTargets = ['package-lock.json', 'client/package-lock.json', 'server/package-lock.json'];
const lockErrors = [];
for (const file of lockTargets) {
  const lock = readJson(file);
  const top = lock.version;
  const rootPackage = lock.packages?.['']?.version;
  if (top !== canonical) lockErrors.push(`${file} top-level=${top ?? 'missing'}`);
  if (rootPackage !== canonical) lockErrors.push(`${file} packages[""].version=${rootPackage ?? 'missing'}`);
}
if (lockErrors.length) {
  console.error('Lockfile application-version metadata must match the release version:');
  lockErrors.forEach((line) => console.error(`  ${line}`));
  process.exit(1);
}

const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
const badge = readme.match(/img\.shields\.io\/badge\/version-([0-9]+\.[0-9]+\.[0-9]+)-blue/);
if (!badge || badge[1] !== canonical) {
  console.error(`README version badge mismatch: expected ${canonical}, found ${badge?.[1] ?? 'missing'}`);
  process.exit(1);
}

console.log(`Version consistency OK: ${canonical} across packages, lockfiles and README badge`);
