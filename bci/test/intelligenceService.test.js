import { describe, it, expect, beforeEach, vi } from 'vitest';
import { query } from '../src/db/client.js';
import { resetDatabase } from './helpers/db.js';
import { upsertVulnerability, getOrEnrichVulnerability, getFreshness } from '../src/services/intelligence.js';

beforeEach(resetDatabase);

describe('upsertVulnerability (merge semantics)', () => {
  it('never overwrites an existing field with null, and kev only ever turns true', async () => {
    await upsertVulnerability({ cveId: 'CVE-2099-00001', kev: true, kevDateAdded: '2026-01-01' });
    await upsertVulnerability({ cveId: 'CVE-2099-00001', cvssScore: 9.1, cvssVector: 'CVSS:3.1/X' });

    const { rows } = await query('SELECT * FROM vulnerabilities WHERE cve_id = $1', ['CVE-2099-00001']);
    expect(rows[0].kev).toBe(true);
    expect(rows[0].kev_date_added.toISOString().slice(0, 10)).toBe('2026-01-01');
    expect(Number(rows[0].cvss_score)).toBe(9.1);
  });
});

describe('getOrEnrichVulnerability (works from cache, degrades gracefully on network failure)', () => {
  it('returns fresh cached data without touching the network', async () => {
    await upsertVulnerability({ cveId: 'CVE-2099-00002', description: 'cached description' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('should not be called'));
    const result = await getOrEnrichVulnerability('CVE-2099-00002');
    expect(result.description).toBe('cached description');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('falls back to stale cached data (not an error) when live enrichment fails', async () => {
    await upsertVulnerability({ cveId: 'CVE-2099-00003', description: 'stale but known' });
    await query("UPDATE vulnerabilities SET updated_at = now() - interval '60 days' WHERE cve_id = $1", ['CVE-2099-00003']);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network unreachable'));
    const result = await getOrEnrichVulnerability('CVE-2099-00003');
    expect(result.description).toBe('stale but known'); // not thrown, not lost
    fetchSpy.mockRestore();

    const freshness = await getFreshness();
    expect(freshness.some((f) => f.source === 'nvd' && f.status === 'FAILED')).toBe(true);
  });

  it('returns null for a CVE with no cached data and no reachable source', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network unreachable'));
    const result = await getOrEnrichVulnerability('CVE-2099-00004');
    expect(result).toBeNull();
    fetchSpy.mockRestore();
  });
});
