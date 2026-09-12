#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function parseVersion(value) {
  const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Geçersiz semver: ${value}`);
  return match.slice(1).map(Number);
}

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

const currentPkg = JSON.parse(readFileSync('package.json', 'utf8'));
let previousPkg;
try {
  const previousRaw = execFileSync('git', ['show', 'HEAD^:package.json'], { encoding: 'utf8' });
  previousPkg = JSON.parse(previousRaw);
} catch (error) {
  console.log('Önceki commit bulunamadı; ilk commit için sürüm artışı kontrolü atlandı.');
  process.exit(0);
}

const current = parseVersion(currentPkg.version);
const previous = parseVersion(previousPkg.version);

if (compare(current, previous) <= 0) {
  console.error(`Sürüm artırılmamış: önceki=${previousPkg.version}, mevcut=${currentPkg.version}`);
  console.error('Her commit/push yeni ve daha yüksek bir BQI sürümü taşımalıdır.');
  process.exit(1);
}

console.log(`Version bump OK: ${previousPkg.version} -> ${currentPkg.version}`);
