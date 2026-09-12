import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// v3.0.62 shipped a crash-on-launch bug: main.js imported CancellationToken
// from 'builder-util-runtime', a package that was only ever a *transitive*
// dependency (nested inside electron-updater's own node_modules, and
// separately hoisted to the repo root only because devDependencies like
// electron-builder happen to need it too). electron-builder's packaged app
// doesn't ship devDependencies, and Node's module resolution for a bare
// import from desktop/main.js can't see into electron-updater's private
// nested copy -- so the one copy dev/test could resolve was never actually
// in the installer, and every real install crashed with
// "Uncaught Exception: Error [ERR_MODULE_NOT_FOUND]: Cannot find package
// 'builder-util-runtime'" the moment the app launched. Nothing caught this
// before it shipped: vitest, `npm run desktop`, and every other dev-time
// check all run against the full (non-pruned) node_modules install, so
// they all resolved it fine. This test statically checks every bare
// (non-relative, non-node:) import under desktop/ against package.json's
// "dependencies" -- the one list electron-builder's default packaging
// actually uses -- so the same class of bug fails a test run instead of a
// real user's launch.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

// 'electron' is deliberately never a "dependencies" entry (it's listed
// under devDependencies): electron-builder always excludes it from the
// packaged node_modules on purpose, because the running Electron binary
// provides that module itself at runtime.
const RUNTIME_PROVIDED = new Set(['electron']);

function listJsFilesRecursive(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJsFilesRecursive(full);
    if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) return [full];
    return [];
  });
}

function extractBareImportSpecifiers(source) {
  const specifiers = new Set();
  // import ... from 'x'; import 'x'; export ... from 'x' -- all require the
  // keyword directly followed by the quoted specifier at a statement
  // boundary, so this can't match a specifier-shaped phrase inside a
  // comment or string (e.g. a comment ending in `from "some text"`).
  const pattern = /^\s*(?:import|export)(?:[^'"]*?\bfrom)?\s+['"]([^'"]+)['"]/gm;
  let match;
  while ((match = pattern.exec(source)) != null) {
    const specifier = match[1];
    if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('node:')) {
      specifiers.add(specifier);
    }
  }
  return specifiers;
}

// A scoped package's own package name is "@scope/name" even though a
// subpath import (e.g. "@scope/name/sub") is legal -- dependencies are
// declared by the former, so that's what must be checked.
function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

describe('desktop/ imports only packages declared in package.json dependencies', () => {
  it('never imports a package that electron-builder would prune from the packaged app', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
    const declaredDependencies = new Set(Object.keys(pkg.dependencies || {}));

    const desktopDir = path.join(repoRoot, 'desktop');
    const files = listJsFilesRecursive(desktopDir);
    expect(files.length).toBeGreaterThan(0);

    const missing = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf-8');
      for (const specifier of extractBareImportSpecifiers(source)) {
        const packageName = packageNameOf(specifier);
        if (!RUNTIME_PROVIDED.has(packageName) && !declaredDependencies.has(packageName)) {
          missing.push(`${path.relative(repoRoot, file)} imports "${packageName}"`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
