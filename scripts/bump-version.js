#!/usr/bin/env node
// Bumps the patch version in root/client/server package.json files together
// (one shared BQI release number), keeps the corresponding
// package-lock.json headers aligned, and updates the README version badge
// to the same release. Also bumps bci/ and bci/ui/ each on their OWN
// independent patch counter -- BCI is a separately deployed product (see
// bci/README.md), so its version line is deliberately never synced to
// BQI's, even though this same script (and the same pre-commit hook)
// advances both on every commit, whichever side actually changed.
// Run automatically by .husky/pre-commit before every commit; the updated
// files are then staged into that same commit.
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const jsonTargets = [
  'package.json',
  'client/package.json',
  'server/package.json',
].map((p) => path.join(root, p));

const lockTargets = [
  'package-lock.json',
  'client/package-lock.json',
  'server/package-lock.json',
].map((p) => path.join(root, p));

const rootPkg = JSON.parse(readFileSync(jsonTargets[0], 'utf-8'));
const [major, minor, patch] = rootPkg.version.split('.').map(Number);
const nextVersion = `${major}.${minor}.${patch + 1}`;

for (const file of jsonTargets) {
  const pkg = JSON.parse(readFileSync(file, 'utf-8'));
  pkg.version = nextVersion;
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
}

for (const file of lockTargets) {
  const lock = JSON.parse(readFileSync(file, 'utf-8'));
  lock.version = nextVersion;
  if (lock.packages?.['']) lock.packages[''].version = nextVersion;
  writeFileSync(file, JSON.stringify(lock, null, 2) + '\n');
}

const readmePath = path.join(root, 'README.md');
if (existsSync(readmePath)) {
  const readme = readFileSync(readmePath, 'utf-8');
  const updated = readme.replace(
    /version-\d+\.\d+\.\d+-blue/,
    `version-${nextVersion}-blue`
  );
  writeFileSync(readmePath, updated);
}

console.log(`Version bumped: ${rootPkg.version} -> ${nextVersion}`);

// BCI's own independent release line -- bumped every commit too, but
// starting from BCI's own current version, not BQI's.
function bumpIndependent(pkgRelPath, lockRelPath, readmeRelPath = null) {
  const pkgPath = path.join(root, pkgRelPath);
  if (!existsSync(pkgPath)) return;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const previous = pkg.version;
  const [maj, min, pat] = pkg.version.split('.').map(Number);
  const next = `${maj}.${min}.${pat + 1}`;
  pkg.version = next;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  const lockPath = path.join(root, lockRelPath);
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
    lock.version = next;
    if (lock.packages?.['']) lock.packages[''].version = next;
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  }

  if (readmeRelPath) {
    const independentReadmePath = path.join(root, readmeRelPath);
    if (existsSync(independentReadmePath)) {
      const readme = readFileSync(independentReadmePath, 'utf-8');
      const updated = readme.replace(
        /version-\d+\.\d+\.\d+-blue/,
        `version-${next}-blue`
      );
      writeFileSync(independentReadmePath, updated);
    }
  }

  console.log(`Version bumped (${pkgRelPath}): ${previous} -> ${next}`);
}

bumpIndependent('bci/package.json', 'bci/package-lock.json', 'bci/README.md');
bumpIndependent('bci/ui/package.json', 'bci/ui/package-lock.json');
