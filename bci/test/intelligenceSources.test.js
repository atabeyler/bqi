import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseKevFeed } from '../src/intelligence/sources/kev.js';
import { parseEpssResponse } from '../src/intelligence/sources/epss.js';
import { parseNvdCve } from '../src/intelligence/sources/nvd.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/intelligence', name), 'utf8'));

describe('intelligence source parsers (pure, against captured real API responses)', () => {
  it('parses a real CISA KEV feed entry', () => {
    const entries = parseKevFeed(load('kev-sample.json'));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].cveId).toMatch(/^CVE-\d{4}-\d+$/);
    expect(entries[0].dateAdded).toBeDefined();
    expect(Array.isArray(entries[0].cweIds)).toBe(true);
  });

  it('parses a real FIRST EPSS response, converting string scores to numbers', () => {
    const [entry] = parseEpssResponse(load('epss-sample.json'));
    expect(entry.cveId).toBe('CVE-2019-10744');
    expect(entry.epssScore).toBeCloseTo(0.05006, 4);
    expect(entry.epssPercentile).toBeCloseTo(0.91657, 4);
  });

  it('parses a real NVD CVE 2.0 response, preferring CVSS v3.1', () => {
    const parsed = parseNvdCve(load('nvd-sample.json'));
    expect(parsed.cveId).toBe('CVE-2019-10744');
    expect(parsed.cvssVector).toContain('CVSS:3.1');
    expect(parsed.cvssScore).toBe(9.1);
    expect(parsed.cweIds).toContain('CWE-1321');
    expect(parsed.description).toContain('Prototype Pollution');
  });

  it('returns null for an NVD response with no matching vulnerability', () => {
    expect(parseNvdCve({ vulnerabilities: [] })).toBeNull();
  });
});
