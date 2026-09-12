import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '../db/client.js';
import { signBundlePayload, verifyBundle } from '../intelligence/bundleSigning.js';
import { upsertVulnerability } from './intelligence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_FORMAT_VERSION = 1;
const BCI_VERSION = JSON.parse(readFileSync(path.join(__dirname, '../../package.json'), 'utf8')).version;

// Builds a signed, self-contained snapshot of the local intelligence
// knowledge base -- everything a Sovereign/air-gapped instance needs to
// stay current without ever reaching NVD/KEV/EPSS itself (spec section 53).
export async function exportBundle(privateKeyPem) {
  const { rows: vulnerabilities } = await query(
    `SELECT cve_id, description, cwe_ids, cvss_vector, cvss_score, published_at, modified_at,
            kev, kev_date_added, kev_due_date, epss_score, epss_percentile, epss_updated_at
       FROM vulnerabilities`
  );

  const payload = {
    bundleFormatVersion: BUNDLE_FORMAT_VERSION,
    bciVersion: BCI_VERSION,
    createdAt: new Date().toISOString(),
    vulnerabilities,
  };

  return signBundlePayload(payload, privateKeyPem);
}

// Verifies, then merges -- never destructive (upsertVulnerability's own
// COALESCE semantics apply here exactly as they do for a live NVD/KEV/EPSS
// sync, M8). A bundle that fails verification imports nothing at all.
export async function importBundle(signedBundle, publicKeyPem) {
  if (!verifyBundle(signedBundle, publicKeyPem)) {
    return { status: 'REJECTED', reason: 'signature_verification_failed', itemCount: 0 };
  }

  const { vulnerabilities } = signedBundle.payload;
  for (const v of vulnerabilities) {
    await upsertVulnerability({
      cveId: v.cve_id,
      description: v.description,
      cweIds: v.cwe_ids,
      cvssVector: v.cvss_vector,
      cvssScore: v.cvss_score != null ? Number(v.cvss_score) : null,
      publishedAt: v.published_at,
      modifiedAt: v.modified_at,
      kev: v.kev,
      kevDateAdded: v.kev_date_added,
      kevDueDate: v.kev_due_date,
      epssScore: v.epss_score != null ? Number(v.epss_score) : null,
      epssPercentile: v.epss_percentile != null ? Number(v.epss_percentile) : null,
      epssUpdatedAt: v.epss_updated_at,
    });
  }

  await query(
    "INSERT INTO intelligence_updates (source, status, item_count, detail) VALUES ('bundle', 'SUCCESS', $1, $2)",
    [vulnerabilities.length, `bundle created ${signedBundle.payload.createdAt} by BCI ${signedBundle.payload.bciVersion}`]
  );

  return { status: 'IMPORTED', itemCount: vulnerabilities.length };
}
