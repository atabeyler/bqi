import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db/client.js';
import { resetDatabase } from './helpers/db.js';
import { exportBundle, importBundle } from '../src/services/bundle.js';
import { generateBundleKeyPair } from '../src/intelligence/bundleSigning.js';
import { upsertVulnerability } from '../src/services/intelligence.js';

beforeEach(resetDatabase);

describe('offline intelligence bundle export/import (integration)', () => {
  it('round-trips the local knowledge base through export -> import into an empty database', async () => {
    const { publicKeyPem, privateKeyPem } = generateBundleKeyPair();
    await upsertVulnerability({ cveId: 'CVE-2099-60001', cvssScore: 9.1, kev: true, description: 'test vuln' });
    await upsertVulnerability({ cveId: 'CVE-2099-60002', cvssScore: 4.0, kev: false });

    const bundle = await exportBundle(privateKeyPem);
    expect(bundle.payload.vulnerabilities).toHaveLength(2);

    await query('TRUNCATE vulnerabilities'); // simulate a fresh air-gapped instance

    const result = await importBundle(bundle, publicKeyPem);
    expect(result.status).toBe('IMPORTED');
    expect(result.itemCount).toBe(2);

    const { rows } = await query('SELECT * FROM vulnerabilities WHERE cve_id = $1', ['CVE-2099-60001']);
    expect(rows[0].kev).toBe(true);
    expect(Number(rows[0].cvss_score)).toBe(9.1);
    expect(rows[0].description).toBe('test vuln');
  });

  it('rejects a bundle signed by an untrusted key and imports nothing', async () => {
    const trusted = generateBundleKeyPair();
    const untrusted = generateBundleKeyPair();
    await upsertVulnerability({ cveId: 'CVE-2099-60003', kev: true });

    const bundle = await exportBundle(untrusted.privateKeyPem);
    await query('TRUNCATE vulnerabilities');

    const result = await importBundle(bundle, trusted.publicKeyPem);
    expect(result.status).toBe('REJECTED');
    expect(result.itemCount).toBe(0);

    const { rows } = await query('SELECT count(*)::int AS n FROM vulnerabilities');
    expect(rows[0].n).toBe(0);
  });

  it('a tampered bundle (e.g. flipping kev to hide/add exploitation status) is rejected', async () => {
    const { publicKeyPem, privateKeyPem } = generateBundleKeyPair();
    await upsertVulnerability({ cveId: 'CVE-2099-60004', kev: false });
    const bundle = await exportBundle(privateKeyPem);

    const tampered = {
      ...bundle,
      payload: { ...bundle.payload, vulnerabilities: bundle.payload.vulnerabilities.map((v) => ({ ...v, kev: true })) },
    };

    const result = await importBundle(tampered, publicKeyPem);
    expect(result.status).toBe('REJECTED');
  });

  it('merges into an existing knowledge base rather than overwriting it destructively', async () => {
    const { publicKeyPem, privateKeyPem } = generateBundleKeyPair();
    await upsertVulnerability({ cveId: 'CVE-2099-60005', description: 'from bundle', kev: true });
    const bundle = await exportBundle(privateKeyPem);

    // The air-gapped side already has its own EPSS data for the same CVE.
    await query('TRUNCATE vulnerabilities');
    await upsertVulnerability({ cveId: 'CVE-2099-60005', epssScore: 0.42 });

    await importBundle(bundle, publicKeyPem);

    const { rows } = await query('SELECT * FROM vulnerabilities WHERE cve_id = $1', ['CVE-2099-60005']);
    expect(rows[0].description).toBe('from bundle');
    expect(Number(rows[0].epss_score)).toBe(0.42); // preserved, not blanked by the bundle's missing epss field
  });
});
