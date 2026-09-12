#!/usr/bin/env node
// Flags client components that render Turkish-only text but never wire into
// the i18n system, so a whole screen or panel can silently stay Turkish
// regardless of the selected language (this happened to HomeView.jsx,
// DecisionTracePanel.jsx, and FileAttach.jsx before they were fixed). This
// is separate from the codebase's deliberate convention of hardcoding some
// Turkish strings inside components that ARE otherwise wired to t() — that
// pattern is intentional and not what this script looks for.
//
// A file is flagged when it contains Turkish-specific characters
// (çğıöşü/ÇĞİÖŞÜ) but has no `useLang`/`langContext` import and never
// receives/calls `t(` — unless it's listed in ALLOWLIST below as a known,
// reviewed exception (e.g. a component that takes `t` as a prop from its
// parent, or is genuinely native-only/deliberately Turkish-only).
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const componentsDir = path.join(__dirname, '..', 'client', 'src', 'components');
const pagesDir = path.join(__dirname, '..', 'client', 'src', 'pages');

// Known, reviewed exceptions - either deliberately Turkish-only (native-app
// chrome, admin-only tooling not yet worth internationalizing) or wired via
// a `t` prop passed down from a parent rather than importing useLang here.
const ALLOWLIST = new Set([
  'AppMenus.jsx', // receives `t`/`lang` as props from DashboardPage
  'DesktopSyncBadge.jsx', // native-app-only status chip, renders nothing on web
  'UserManagement.jsx', // known gap: admin-only panel, tracked separately
]);

const TURKISH_CHARS = /[çğıöşüÇĞİÖŞÜ]/;
const HAS_I18N_HOOK = /useLang|langContext|\bt\(/;

function listJsxFiles(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsx') && !f.endsWith('.test.jsx'))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

const files = [...listJsxFiles(componentsDir), ...listJsxFiles(pagesDir)];

const offenders = files.filter((file) => {
  const base = path.basename(file);
  if (ALLOWLIST.has(base)) return false;
  const content = readFileSync(file, 'utf-8');
  return TURKISH_CHARS.test(content) && !HAS_I18N_HOOK.test(content);
});

if (offenders.length) {
  console.error('Components with Turkish text but no i18n wiring (add useLang()/t(), or add to ALLOWLIST in scripts/check-i18n.js if this is a deliberate exception):');
  offenders.forEach((f) => console.error(`  ${path.relative(path.join(__dirname, '..'), f)}`));
  process.exit(1);
}

console.log(`i18n wiring check OK: ${files.length} component files scanned, ${ALLOWLIST.size} allowlisted.`);
