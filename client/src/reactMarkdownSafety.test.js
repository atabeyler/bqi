import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = __dirname;

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (/\.(jsx?|tsx?)$/.test(entry.name)) files.push(full);
  }
  return files;
}

// react-markdown (used across AnalysisView/ConsultChat/HistoryView/
// VoiceChat/MemoryPanel to render AI-generated and report content) does
// NOT render raw HTML by default -- that's what keeps those call sites
// XSS-safe today with no sanitize schema configured. The only thing that
// would reopen that path is adding react-markdown's `rehype-raw` plugin
// (which turns embedded HTML back on) without also adding `rehype-sanitize`
// alongside it. This guards against that combination sneaking in silently.
describe('react-markdown stays raw-HTML-off across the app', () => {
  it('never imports rehype-raw without rehype-sanitize next to it', () => {
    const offenders = [];
    for (const file of walk(SRC_DIR)) {
      const content = fs.readFileSync(file, 'utf8');
      if (/rehype-raw/.test(content) && !/rehype-sanitize/.test(content)) {
        offenders.push(path.relative(SRC_DIR, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
